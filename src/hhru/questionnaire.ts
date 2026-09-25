/**
 * Обработка анкет (тестовых заданий).
 * Кандидаты в стадии «Первичный контакт» заполняют Google-форму; её ответы лежат в
 * отдельной таблице (ссылка в листе «Доп. фильтры», колонка «Анкета»).
 * Бот матчит ответ с кандидатом по имени (+телефон), оценивает ответы ИИ и пишет
 * результат в лист «ИИ анализ тестового задания» в таблице вакансии.
 *
 * Действий на HH пока НЕ делает — только анализ и запись в таблицу.
 */
import { sheets } from "../google/sheets.client";
import {
    getAllNewResponses,
    getAllConsiderResponses,
    getAllNegotiationsByCollection,
    getResume,
    extractActions,
    employerStage,
    sendCandidateMessage,
    doNegotiationAction,
    getNegotiation,
    getConversationMessages,
    type HhNegotiation,
} from "./hh-api";
import { categoryForDecision, shouldSkipSend, hasAnyDecision } from "./message-dedup";
import { isVacancyArchived, queueArchivedContact, vacancyLiveOverride } from "./archived-notify";
import { askAi, parseAiJsonText } from "./ai-scorer";
import { extractSpreadsheetId, readTemplates, findTemplate, fillTemplate } from "./sheets-analysis";
import { registerInterviewConversation } from "./interview-chat";
import { getInterviewChatState, updateInterviewChatState } from "./interview-chat.store";
import {
    markQuestionnaireSourceProcessed,
    questionnaireSourceKey,
    readProcessedQuestionnaireSources,
} from "./questionnaire-source.store";
import { beginVacancyRun, canContinueVacancyRun } from "./vacancy-activity";

const FILTERS_SHEET = "Доп. фильтры";
const RESULT_SHEET = "ИИ анализ тестового задания";
/**
 * Индекс колонки со ссылкой на резюме. Терпим к разному порядку слов:
 * стандартное «Ссылка на резюме», но у части старых таблиц — «РЕЗЮМЕ ССЫЛКА».
 * Приоритет точному совпадению, иначе — любой заголовок с «резюме» и «ссыл».
 */
function findResumeLinkIdx(headers: string[]): number {
    const norm = headers.map((h) => String(h || "").trim().toLowerCase());
    const exact = norm.indexOf("ссылка на резюме");
    if (exact >= 0) return exact;
    return norm.findIndex((h) => h.includes("резюме") && h.includes("ссыл"));
}
const EMPTY_HEADERS = ["", "вопрос без заголовка"];
// В этой конкретной форме отдельной колонки телефона нет, а вопросы уже
// пронумерованы в самих заголовках (2–24). Для остальных форм старая схема
// «время, имя, телефон, вопросы» остаётся без изменений.
const NUMBERED_FORM_WITHOUT_PHONE_ID = "1TYzJKQ6xAIolEeF-qtAf32tTOMe9ofxN9ZG9CYzkwTI";
// Форма «Инженер изобретатель»: пронумерованные вопросы 1–10, ФИО в отдельной
// колонке справа, телефона нет, есть колонка со ссылкой на резюме.
const ENGINEER_FORM_ID = "1mOTlN2fr-VBjWguWnV5k-0AI-0f26WBfooDAJyuROHA";
const FIXED_RESULT_RANGE_SPREADSHEET_ID = "1pf74G1-eftdSiKjROY8Pyi3SN1t6qMJTESHde_a6yBc";
const QUESTIONNAIRE_WITHOUT_STAGE_VACANCY_IDS = new Set(["133959149"]);
const QUESTIONNAIRE_HH_ACTIONS_ENABLED = process.env.QUESTIONNAIRE_HH_ACTIONS === "true";

// ===== Чтение ссылки на анкету из «Доп. фильтры» =====
export async function readAnketaUrl(templatesSpreadsheetId: string): Promise<string> {
    const resp = await sheets.spreadsheets.values.get({
        spreadsheetId: templatesSpreadsheetId,
        range: `${FILTERS_SHEET}!A:Z`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return "";
    const headers = rows[0].map((h) => String(h).trim().toLowerCase());
    const col = headers.findIndex((h) => h === "анкета");
    if (col === -1) return "";
    for (const row of rows.slice(1)) {
        const v = String(row[col] || "").trim();
        if (v) return v;
    }
    return "";
}

// ===== Чтение ответов формы =====
export interface FormQuestion {
    num: number; // номер вопроса (нумерация с 3)
    title: string;
    colIndex: number; // индекс колонки в исходной таблице
}
export interface FormAnswer {
    name: string;
    phone: string;
    resumeUrl?: string;
    /** Дата отправки анкеты в формате YYYY-MM-DD (из «Отметка времени»). */
    submittedAt?: string;
    sourceKey: string;
    answers: { num: number; title: string; answer: string }[];
}

/** «02.09.2024 18:30:20» -> «2024-09-02»; пусто, если формат не распознан. */
function parseFormDate(raw: string): string {
    const m = String(raw || "").match(/^\s*(\d{2})\.(\d{2})\.(\d{4})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/**
 * Нижняя граница даты анкет для вакансии: ANKETA_MIN_DATE_<vacancyId>,
 * иначе общий ANKETA_MIN_DATE. Формат YYYY-MM-DD. Пусто — берём все.
 */
function anketaMinDate(vacancyId: string): string {
    return String(
        process.env[`ANKETA_MIN_DATE_${vacancyId}`] || process.env.ANKETA_MIN_DATE || "",
    ).trim();
}
export interface FormData {
    questions: FormQuestion[];
    answers: FormAnswer[];
}

export async function readFormResponses(formUrl: string): Promise<FormData> {
    const spreadsheetId = extractSpreadsheetId(formUrl);
    if (!spreadsheetId) throw new Error("не удалось извлечь ID таблицы анкеты из ссылки");

    // первый лист таблицы ответов
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
    const firstSheet = meta.data.sheets?.[0]?.properties?.title;
    if (!firstSheet) throw new Error("в таблице анкеты нет листов");

    const resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${firstSheet}!A:ZZ`,
    });
    const rows = resp.data.values || [];
    if (rows.length < 2) return { questions: [], answers: [] };

    const rawHeaders = rows[0].map((h) => String(h || "").trim());

    // оставляем только колонки с настоящим заголовком (без пустых и «Вопрос без заголовка»)
    const kept: { colIndex: number; title: string }[] = [];
    rawHeaders.forEach((h, i) => {
        if (!EMPTY_HEADERS.includes(h.toLowerCase())) kept.push({ colIndex: i, title: h });
    });

    const isNumberedFormWithoutPhone = spreadsheetId === NUMBERED_FORM_WITHOUT_PHONE_ID;
    const isEngineerForm = spreadsheetId === ENGINEER_FORM_ID;
    // Обе формы — пронумерованные, без телефона.
    const isNumberedForm = isNumberedFormWithoutPhone || isEngineerForm;

    // Служебные колонки — не вопросы. HR часто дописывает свои («Краткий
    // комментарий», «Статус»), из-за чего позиционный разбор съезжал.
    const SERVICE_RE = /отметка времени|краткий коммент|^статус$|адрес электронной почты|e-?mail|почта/i;
    const NAME_RE = /фио|фамили|как вас зовут|представьтесь|ваше\s*(полное\s*)?имя|ваши\s+фамили|напишите\s+ваши/i;
    const PHONE_RE = /телефон|моб\.|phone/i;

    const resumeCol = rawHeaders.findIndex((h) => /резюме|resume/i.test(h));
    const timeByHeader = rawHeaders.findIndex((h) => /отметка времени/i.test(h));
    const timeCol = timeByHeader >= 0 ? timeByHeader : (kept[0]?.colIndex ?? 0);
    const nameByHeader = rawHeaders.findIndex((h) => NAME_RE.test(h));
    const phoneByHeader = rawHeaders.findIndex((h) => PHONE_RE.test(h));

    // Колонки ищем по заголовку; если подходящего нет — старая позиционная схема
    // (kept[0]=время, kept[1]=имя, kept[2]=телефон, kept[3+]=вопросы).
    const nameCol = nameByHeader >= 0 ? nameByHeader : (kept[1]?.colIndex ?? 1);
    let phoneCol: number;
    if (isNumberedForm) {
        phoneCol = -1;
    } else if (phoneByHeader >= 0) {
        phoneCol = phoneByHeader;
    } else {
        // запасная колонка годится, только если это не служебное поле (напр. email)
        const fallback = kept[2]?.colIndex ?? 2;
        phoneCol = SERVICE_RE.test(rawHeaders[fallback] || "") ? -1 : fallback;
    }

    // Порог номера вопроса: у Аналитика первые пункты — не вопросы, берём с 3;
    // у «Инженера» вопросы нумеруются с 1.
    const minQuestionNum = isEngineerForm ? 1 : 3;
    const questions: FormQuestion[] = isNumberedForm
        ? kept.flatMap((k) => {
            const match = k.title.match(/^\s*(\d+)\s*[.)]/);
            if (!match) return [];
            const num = Number(match[1]);
            return num >= minQuestionNum ? [{ num, title: k.title, colIndex: k.colIndex }] : [];
        })
        : (() => {
            const skip = new Set([nameCol, phoneCol, resumeCol].filter((x) => x >= 0));
            // Нумерация с 3 — совпадает со старой позиционной для обычных форм,
            // поэтому колонки «Ответ на N вопрос» в таблицах остаются валидными.
            return kept
                .filter((k) => !skip.has(k.colIndex) && !SERVICE_RE.test(k.title))
                .map((k, i) => ({ num: i + 3, title: k.title, colIndex: k.colIndex }));
        })();

    const answers: FormAnswer[] = rows.slice(1)
        .filter((row) => row.some((c) => String(c || "").trim()))
        .map((row) => ({
            name: String(row[nameCol] || "").trim(),
            phone: phoneCol >= 0 ? String(row[phoneCol] || "").trim() : "",
            resumeUrl: resumeCol >= 0 ? String(row[resumeCol] || "").trim() : "",
            submittedAt: parseFormDate(String(row[timeCol] || "")),
            sourceKey: questionnaireSourceKey(spreadsheetId, firstSheet, row),
            answers: questions.map((q) => ({
                num: q.num,
                title: q.title,
                answer: String(row[q.colIndex] || "").trim(),
            })),
        }));

    return { questions, answers };
}

// ===== Матчинг ответа формы с кандидатом из «Первичный контакт» =====
function normName(s: string): string[] {
    return String(s || "").toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean);
}
function normPhone(s: string): string {
    const d = String(s || "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : d;
}

function candidateFullName(n: HhNegotiation): string {
    return [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name].filter(Boolean).join(" ");
}

/** Извлекает нормализованный телефон из полного резюме */
export function extractPhoneFromResume(resume: any): string {
    const contacts = resume?.contact || [];
    for (const c of contacts) {
        const raw =
            c?.value?.formatted ||
            (typeof c?.value === "string" ? c.value : "") ||
            c?.contact_value ||
            "";
        const norm = normPhone(raw);
        if (norm.length >= 10) return norm;
    }
    return "";
}

export function matchCandidate(formName: string, candidates: HhNegotiation[]): HhNegotiation | null {
    const formTokens = normName(formName);
    // Одного имени недостаточно: «Максим» не должен автоматически совпадать
    // с любым Максимом, который сейчас находится в «Первичном контакте».
    if (formTokens.length < 2) return null;

    // сколько слов должно совпасть: 1 слово в форме → 1; 2 и больше → минимум 2 (фамилия+имя),
    // чтобы опечатка в отчестве не ломала матч
    const need = 2;

    const scored = candidates
        .map((c) => {
            const candTokens = normName(candidateFullName(c));
            const overlap = formTokens.filter((t) => candTokens.includes(t)).length;
            return { c, overlap };
        })
        .filter((x) => x.overlap >= need)
        .sort((a, b) => b.overlap - a.overlap);

    if (scored.length === 0) return null;
    if (scored.length === 1) return scored[0].c;
    // если у лучшего совпадений строго больше, чем у следующего — берём его; иначе неоднозначно
    return scored[0].overlap > scored[1].overlap ? scored[0].c : null;
}

// ===== Оценка анкеты ИИ =====
export interface QuestionnaireResult {
    perQuestion: { num: number; score: number; comment: string }[];
    avgScore: number;
    verdict: string; // «Прошёл» | «Не прошёл»
    summary: string;
}

export async function evaluateQuestionnaire(
    vacancyName: string,
    answer: FormAnswer
): Promise<QuestionnaireResult> {
    const qaBlock = answer.answers
        .map((a) => `Вопрос ${a.num}: ${a.title}\nОтвет: ${a.answer || "(пусто)"}`)
        .join("\n\n");

    const prompt = `
Ты — HR-ассистент. Оцени ответы кандидата на анкету (тестовое задание) по вакансии "${vacancyName}".

Оцени КАЖДЫЙ вопрос по шкале от 0 до 10. Оценивай ПРЕЖДЕ ВСЕГО суть и релевантность ответа, а не оформление, структуру или объём. Если человек ответил по существу верно и по теме — не занижай балл только за отсутствие деталей, красивой структуры или конкретных цифр.

Шкала (ориентир, будь адекватным и не слишком строгим):
- 0–2: ответа нет, ответ не по теме или бессмысленный.
- 3–4: суть затронута лишь частично или очень поверхностно.
- 5–6: суть ответа верная и по теме, но не хватает конкретики или деталей — это НОРМАЛЬНЫЙ проходной ответ.
- 7–8: содержательный, конкретный и релевантный ответ.
- 9–10: сильный ответ с конкретикой, логикой и результатами.

Важно: низкие баллы (0–2) ставь только когда ответ реально пустой, не по теме или бессмысленный. Если суть верная — ставь не ниже 5.

Верни СТРОГО JSON без markdown:
{
  "questions": [
    { "num": 3, "score": 0, "comment": "краткий комментарий по ответу" }
  ],
  "summary": "общее заключение по кандидату в 2-3 предложениях"
}

Номера вопросов используй ровно те, что указаны ниже.

ОТВЕТЫ КАНДИДАТА:
${qaBlock}
`.trim();

    const aiText = await askAi(prompt);
    const parsed = parseAiJsonText(aiText);

    const perQuestion: { num: number; score: number; comment: string }[] = [];
    const aiQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
    for (const q of answer.answers) {
        const found = aiQuestions.find((x: any) => Number(x.num) === q.num);
        const score = found ? Math.max(0, Math.min(10, Number(found.score) || 0)) : 0;
        perQuestion.push({ num: q.num, score, comment: found?.comment || "" });
    }

    const avgScore = perQuestion.length
        ? Math.round((perQuestion.reduce((s, q) => s + q.score, 0) / perQuestion.length) * 10) / 10
        : 0;

    // правило: любой вопрос <3 → не прошёл; иначе итоговый балл (среднее) ≥5 → прошёл
    const anyBelow3 = perQuestion.some((q) => q.score < 3);
    const verdict = !anyBelow3 && avgScore >= 5 ? "Прошёл" : "Не прошёл";

    return { perQuestion, avgScore, verdict, summary: parsed.summary || "" };
}

// ===== Запись в лист «ИИ анализ тестового задания» =====
const HR_DECISION_HEADER = "Действие HR";
const ANALYSIS_DATE_HEADER = "Дата анализа анкеты";
/** Отметка, что решение HR по этой строке уже исполнено (письмо + действие на HH). */
const SENT_HEADER = "Отправлено";
const HR_OPTIONS = ["Ожидание", "Подходит", "Не подходит"];

/** Текущее время по Москве в формате ДД.ММ.ГГГГ ЧЧ:ММ */
function moscowNow(): string {
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date()).replace(",", "");
}

function columnToLetter(col0: number): string {
    let n = col0 + 1;
    let s = "";
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/**
 * Гарантирует наличие колонки «Действие HR»: добавляет её (если нет), ставит выпадающий список
 * Ожидание/Подходит/Не подходит, цвета (зелёный/красный/серый) через условное форматирование,
 * дефолт «Ожидание» для существующих строк. Идемпотентна: если колонка уже есть — ничего не делает.
 */
export async function ensureHrDecisionColumn(spreadsheetId: string): Promise<void> {
    const meta = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: "sheets(properties(sheetId,title,gridProperties(rowCount)))",
    });
    const sh = meta.data.sheets?.find((s) => s.properties?.title === RESULT_SHEET);
    if (!sh?.properties || sh.properties.sheetId == null) return;
    const sheetId = sh.properties.sheetId;
    const rowCount = sh.properties.gridProperties?.rowCount || 1000;

    const hdr = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!1:1` });
    const headers = (hdr.data.values?.[0] || []).map((h) => String(h).trim());
    const existing = headers.findIndex((h) => h.toLowerCase() === HR_DECISION_HEADER.toLowerCase());
    if (existing !== -1) return; // уже настроено

    const col = headers.length; // добавляем в конец
    const range = { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: col, endColumnIndex: col + 1 };

    const colorRule = (value: string, bg: any) => ({
        addConditionalFormatRule: {
            index: 0,
            rule: {
                ranges: [range],
                booleanRule: {
                    condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
                    format: { backgroundColor: bg },
                },
            },
        },
    });

    const requests: any[] = [
        // заголовок
        {
            updateCells: {
                rows: [{ values: [{ userEnteredValue: { stringValue: HR_DECISION_HEADER } }] }],
                fields: "userEnteredValue",
                start: { sheetId, rowIndex: 0, columnIndex: col },
            },
        },
        // выпадающий список
        {
            setDataValidation: {
                range,
                rule: {
                    condition: { type: "ONE_OF_LIST", values: HR_OPTIONS.map((v) => ({ userEnteredValue: v })) },
                    strict: true,
                    showCustomUi: true,
                },
            },
        },
        colorRule("Подходит", { red: 0.80, green: 0.94, blue: 0.75 }),
        colorRule("Не подходит", { red: 0.96, green: 0.80, blue: 0.80 }),
        colorRule("Ожидание", { red: 0.90, green: 0.90, blue: 0.90 }),
    ];

    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

    // бэкфилл «Ожидание» для существующих строк данных
    const colLetter = columnToLetter(col);
    const dataRows = (await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!A:A` })).data.values || [];
    const lastRow = dataRows.length;
    if (lastRow > 1) {
        const values = Array.from({ length: lastRow - 1 }, () => ["Ожидание"]);
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${RESULT_SHEET}!${colLetter}2:${colLetter}${lastRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values },
        });
    }
    console.log(`[anketa] колонка «${HR_DECISION_HEADER}» настроена (дропдаун + цвета)`);
}

/** Добавляет колонку «Дата анализа анкеты» перед «Действие HR» и снимает с неё ошибочный дропдаун */
async function ensureAnalysisDateColumn(spreadsheetId: string): Promise<void> {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title,gridProperties(rowCount)))" });
    const sh = meta.data.sheets?.find((s) => s.properties?.title === RESULT_SHEET);
    if (!sh?.properties || sh.properties.sheetId == null) return;
    const sheetId = sh.properties.sheetId;
    const rowCount = sh.properties.gridProperties?.rowCount || 1000;

    const hdr = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!1:1` });
    const headers = (hdr.data.values?.[0] || []).map((h) => String(h).trim());
    let dateCol = headers.findIndex((h) => h.toLowerCase() === ANALYSIS_DATE_HEADER.toLowerCase());

    if (dateCol === -1) {
        const hrIdx = headers.findIndex((h) => h.toLowerCase() === HR_DECISION_HEADER.toLowerCase());
        const insertIdx = hrIdx !== -1 ? hrIdx : headers.length;
        const requests: any[] = [];
        if (hrIdx !== -1) {
            requests.push({
                insertDimension: {
                    range: { sheetId, dimension: "COLUMNS", startIndex: insertIdx, endIndex: insertIdx + 1 },
                    inheritFromBefore: false,
                },
            });
        }
        requests.push({
            updateCells: {
                rows: [{ values: [{ userEnteredValue: { stringValue: ANALYSIS_DATE_HEADER } }] }],
                fields: "userEnteredValue",
                start: { sheetId, rowIndex: 0, columnIndex: insertIdx },
            },
        });
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
        dateCol = insertIdx;
        console.log(`[anketa] колонка «${ANALYSIS_DATE_HEADER}» добавлена`);
    }

    // самолечение: снимаем выпадающий список с колонки даты (если он туда попал при вставке)
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
            requests: [{
                setDataValidation: {
                    range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: dateCol, endColumnIndex: dateCol + 1 },
                },
            }],
        },
    });
}

/** Настраивает служебные колонки листа анкет: «Дата анализа анкеты» + «Действие HR» */
function colLetter(idx: number): string {
    let s = "";
    let n = idx;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
}

// Колонка «ФИО»: занимаем первую пустую колонку (обычно рядом со ссылкой), иначе добавляем в конец
async function ensureFioColumn(spreadsheetId: string): Promise<void> {
    const headers = await getResultHeaders(spreadsheetId);
    if (headers.length === 0) return;
    if (headers.some((h) => h.trim().toLowerCase() === "фио")) return;
    let idx = headers.findIndex((h) => !h.trim());
    if (idx === -1) idx = headers.length;
    const col = colLetter(idx);
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${RESULT_SHEET}!${col}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["ФИО"]] },
    });
    console.log(`[anketa] колонка «ФИО» добавлена (${col})`);
}

export async function ensureQuestionnaireColumns(spreadsheetId: string): Promise<void> {
    await ensureFioColumn(spreadsheetId);          // ФИО (первой)
    await ensureAnalysisDateColumn(spreadsheetId); // дата
    await ensureHrDecisionColumn(spreadsheetId);   // решение (в конце)
}

async function getResultHeaders(spreadsheetId: string): Promise<string[]> {
    try {
        const resp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${RESULT_SHEET}!1:1`,
        });
        return (resp.data.values?.[0] || []).map((h) => String(h).trim());
    } catch {
        return [];
    }
}

/** Уже обработанные negotiation_id (из колонки «Ссылка на резюме» ?t=) */
export async function readProcessedNegotiationIds(spreadsheetId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!A:A` });
        const rows = resp.data.values || [];
        for (const row of rows.slice(1)) {
            const m = String(row[0] || "").match(/[?&]t=([^&]+)/);
            if (m) ids.add(m[1]);
        }
    } catch {}
    return ids;
}

export async function appendTestTaskResult(
    spreadsheetId: string,
    resumeUrl: string,
    result: QuestionnaireResult,
    candidateName: string = ""
): Promise<void> {
    const headers = await getResultHeaders(spreadsheetId);
    if (headers.length === 0) throw new Error(`лист "${RESULT_SHEET}" не найден или без заголовков`);

    const row = new Array(headers.length).fill("");
    const resumeLinkIdx = findResumeLinkIdx(headers);
    headers.forEach((h, i) => {
        const hl = h.toLowerCase();
        if (i === resumeLinkIdx) {
            row[i] = resumeUrl;
        } else if (hl === "фио") {
            row[i] = candidateName;
        } else if (hl === "совокупное заключение") {
            row[i] = result.summary;
        } else if (hl === "итоговый балл") {
            row[i] = result.avgScore;
        } else if (hl === ANALYSIS_DATE_HEADER.toLowerCase()) {
            row[i] = moscowNow();
        } else if (hl === HR_DECISION_HEADER.toLowerCase()) {
            row[i] = "Ожидание";
        } else {
            const m = hl.match(/ответ на (\d+) вопрос/);
            if (m) {
                const num = Number(m[1]);
                const q = result.perQuestion.find((x) => x.num === num);
                if (q) row[i] = `${q.score} — ${q.comment}`;
            }
        }
    });

    // ВСЕГДА пишем в явный диапазон, начиная с колонки A, а НЕ через values.append.
    // У Google авто-детект таблицы на широких строках сдвигает строку на колонку вправо
    // (колонка A пустеет), после чего следующие дозаписи затирают эту строку — из-за этого
    // терялись анкеты (Бобров, Дробышев, Зарянов) и «съезжали» ячейки. Явный диапазон
    // A{n}:{lastCol}{n} исключает и сдвиг, и затирание для всех вакансий.
    const lastCol = columnToLetter(headers.length - 1);
    const existing = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${RESULT_SHEET}!A:A`,
    });
    const nextRow = Math.max(2, (existing.data.values || []).length + 1);
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${RESULT_SHEET}!A${nextRow}:${lastCol}${nextRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
    });
}

// ===== Оркестратор обработки анкет по вакансии =====
function hhCandidateName(candidate: HhNegotiation): string {
    return [candidate.resume?.last_name, candidate.resume?.first_name, candidate.resume?.middle_name]
        .filter(Boolean)
        .join(" ") || candidate.resume?.title || "Candidate";
}

async function applyQuestionnaireHhDecision(
    vacancy: QuestionnaireInput,
    candidate: HhNegotiation,
    result: QuestionnaireResult,
    templates: Awaited<ReturnType<typeof readTemplates>>
): Promise<void> {
    const templateCondition = result.verdict === "Прошёл" ? "Успешно" : "Отказ";
    const template = findTemplate(templates, templateCondition, "Тестовое задание");
    const candidateName = hhCandidateName(candidate);
    const message = template ? fillTemplate(template.text, candidateName, vacancy.vacancyName) : "";
    const actions = extractActions(candidate);

    if (result.verdict === "Прошёл") {
        // Приглашаем на собеседование, но кандидат ОСТАЁТСЯ в «первичном контакте».
        // В стадию «Собеседование» переводим только после согласования даты/времени (interview-chat).
        if (message && candidate.messages_url) {
            await sendCandidateMessage(candidate.messages_url, message);
        }
        return;
    }

    if (!actions.action_discard_url) {
        throw new Error("candidate " + candidateName + " has no action_discard");
    }
    await doNegotiationAction(
        actions.action_discard_url,
        actions.action_discard_method,
        message || undefined
    );
}

/**
 * Действия по решению HR из колонки «Действие HR» листа «ИИ анализ тестового задания».
 *   «Подходит»    → приглашение (шаблон Успешно/Тестовое задание) + завод в диалог о собеседовании
 *   «Не подходит» → отказ (шаблон Отказ/Тестовое задание) + discard, диалог закрываем
 *   «Ожидание»/пусто → ничего
 * Идемпотентно: уже приглашённых (есть диалог) и уже отклонённых пропускаем.
 */
export async function processAnketaHrDecisions(
    vacancy: QuestionnaireInput,
    options: { dryRun?: boolean } = {}
): Promise<{ invited: number; rejected: number; skipped: number }> {
    const dryRun = vacancyLiveOverride(vacancy.vacancyId) ? false : (options.dryRun !== false);
    const tag = dryRun ? "[anketa-hr:DRY]" : "[anketa-hr:LIVE]";
    const runToken = beginVacancyRun(vacancy.vacancyId);
    if (!canContinueVacancyRun(runToken)) return { invited: 0, rejected: 0, skipped: 0 };
    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return { invited: 0, rejected: 0, skipped: 0 };

    // Диапазон должен покрывать ВСЕ колонки: «Действие HR» стоит после блока
    // «Ответ на N вопрос» и у широких анкет уезжает за Z (у Аналитика — AB).
    // С A:Z колонка не находилась и шаг молча не делал ничего.
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!A:BZ` });
    const rows = (resp.data.values || []) as string[][];
    if (rows.length < 2) return { invited: 0, rejected: 0, skipped: 0 };
    const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
    const linkIdx = findResumeLinkIdx(headers);
    const hrIdx = headers.findIndex((h) => h === HR_DECISION_HEADER.toLowerCase());
    if (linkIdx === -1 || hrIdx === -1) return { invited: 0, rejected: 0, skipped: 0 };

    // Признак «уже исполнено» держим в самой таблице, а не выводим из состояния на HH.
    // Раньше строка пропускалась, если у кандидата есть диалог о собеседовании или он уже
    // отклонён, — но и то и другое возникает ещё на этапе резюме, поэтому решение HR по
    // анкете для таких кандидатов молча не исполнялось (письмо не уходило).
    let sentIdx = headers.findIndex((h) => h === SENT_HEADER.toLowerCase());
    if (sentIdx === -1) {
        sentIdx = Math.max(rows[0].length, hrIdx + 1);
        if (!dryRun) {
            try {
                await sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${RESULT_SHEET}!${columnToLetter(sentIdx)}1`,
                    valueInputOption: "RAW",
                    requestBody: { values: [[SENT_HEADER]] },
                });
            } catch (e: any) {
                console.warn(`${tag} не смог создать колонку «${SENT_HEADER}»: ${e.message}`);
            }
        }
    }
    const markSent = async (rowNumber: number, note: string) => {
        if (dryRun) return;
        try {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${RESULT_SHEET}!${columnToLetter(sentIdx)}${rowNumber}`,
                valueInputOption: "RAW",
                requestBody: { values: [[`${note} ${moscowNow()}`]] },
            });
        } catch (e: any) {
            console.warn(`${tag} не смог отметить строку ${rowNumber}: ${e.message}`);
        }
    };

    const templates = dryRun ? [] : await readTemplates(spreadsheetId);
    let invited = 0, rejected = 0, skipped = 0, failed = 0;

    for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
        if (!canContinueVacancyRun(runToken)) {
            console.log(`${tag} «${vacancy.vacancyName}» приостановлена — решения HR остановлены`);
            break;
        }
        const row = rows[rowIdx];
        const rowNumber = rowIdx + 1;
        const decision = String(row[hrIdx] || "").trim();
        if (decision !== "Подходит" && decision !== "Не подходит") continue;
        if (String(row[sentIdx] || "").trim()) { skipped++; continue; }
        const link = String(row[linkIdx] || "");
        const negId = (link.match(/[?&]t=([^&]+)/) || [])[1] || "";
        if (!negId) continue;

        // Один проблемный отклик (например, из архивной вакансии — HH отдаёт
        // 403 invalid_vacancy) не должен ронять обработку остальных кандидатов.
        try {
            const hh = await getNegotiation(negId);
            if (!hh) { skipped++; continue; }
            if (!canContinueVacancyRun(runToken)) break;
            const cn = hhCandidateName(hh);
            // Стадия — из воронки работодателя (hh.state залипает на «Отклик»).
            const hhStage = employerStage(hh);
            const sid = String(hhStage.id || "");
            const alreadyDiscarded = sid.startsWith("discard") || hhStage.name === "Отказ";

            // Архивная вакансия: HH вернёт 403 на любую отправку/действие. Не пытаемся.
            // В список «написать вручную» берём ТОЛЬКО тех, с кем ещё не связывались
            // (в чате нет ни отказа, ни приглашения — ни от бота, ни вручную).
            if (await isVacancyArchived(vacancy.vacancyId)) {
                const chat = hh.messages_url ? await getConversationMessages(hh.messages_url).catch(() => []) : [];
                if (!canContinueVacancyRun(runToken)) break;
                if (hasAnyDecision(chat)) {
                    console.log(`${tag} 🗄 ${cn}: архив, но контакт уже был — пропуск`);
                } else {
                    queueArchivedContact(vacancy.vacancyId, vacancy.vacancyName, { name: cn, negotiationId: negId, link });
                    console.log(`${tag} 🗄 ${cn}: архив, не связывались — в список на ручную отправку`);
                }
                await markSent(rowNumber, "архив — вручную");
                skipped++;
                continue;
            }

            // ДЕДУП: если в чате уже есть сообщение нужного типа (прислал бот ИЛИ руководитель
            // вручную) — не отправляем повторно. Отказ распознаётся одинаково на всех стадиях.
            const intendedCat = categoryForDecision(decision, "anketa");
            if (intendedCat && hh.messages_url) {
                const chat = await getConversationMessages(hh.messages_url).catch(() => []);
                if (!canContinueVacancyRun(runToken)) break;
                const s = shouldSkipSend(chat, intendedCat);
                if (s.skip) {
                    console.log(`${tag} ⏭ ${cn}: ${s.reason} — повторно/поверх НЕ отправляю`);
                    await markSent(rowNumber, s.reason);
                    skipped++;
                    continue;
                }
            }

            if (decision === "Подходит") {
                console.log(`${tag} ✉ ПРИГЛАШЕНИЕ: ${vacancy.vacancyName} / ${cn}`);
                if (!dryRun) {
                    if (!canContinueVacancyRun(runToken)) break;
                    const tpl = findTemplate(templates, "Успешно", "Тестовое задание");
                    const msg = tpl ? fillTemplate(tpl.text, cn, vacancy.vacancyName) : "";
                    // Раньше эти случаи молчали: в лог шло «ПРИГЛАШЕНИЕ», а письмо не уходило.
                    if (!tpl) console.warn(`${tag} ⚠ ${cn}: нет шаблона «Успешно + Тестовое задание» — письмо НЕ отправлено`);
                    else if (!hh.messages_url) console.warn(`${tag} ⚠ ${cn}: нет переписки на HH — письмо НЕ отправлено`);
                    else await sendCandidateMessage(hh.messages_url, msg);
                    // Двигаем по воронке: приглашённый на собеседование не должен
                    // оставаться в «Подумать» — иначе стадия на HH не отражает реальность.
                    const acts = extractActions(hh);
                    if (acts.action_interview_url && !["interview", "offer", "hired"].includes(sid)) {
                        try {
                            await doNegotiationAction(acts.action_interview_url, acts.action_interview_method);
                            console.log(`${tag} → ${cn}: стадия переведена в «Собеседование»`);
                        } catch (e: any) {
                            console.warn(`${tag} ⚠ ${cn}: не смог перевести стадию: ${e.message}`);
                        }
                    }
                    await registerInterviewConversation(vacancy, hh);
                    await markSent(rowNumber, "приглашение");
                }
                invited++;
            } else {
                const actions = extractActions(hh);
                console.log(`${tag} ✗ ОТКАЗ: ${vacancy.vacancyName} / ${cn}`);
                if (!dryRun) {
                    if (!canContinueVacancyRun(runToken)) break;
                    const tpl = findTemplate(templates, "Отказ", "Тестовое задание");
                    const msg = tpl ? fillTemplate(tpl.text, cn, vacancy.vacancyName) : "";
                    if (!tpl) console.warn(`${tag} ⚠ ${cn}: нет шаблона «Отказ + Тестовое задание» — отказ без письма`);
                    if (alreadyDiscarded) {
                        // Стадия уже «Отказ» — повторное действие HH отклонит, но письмо
                        // кандидат так и не получил, поэтому отправляем его отдельно.
                        if (msg && hh.messages_url) await sendCandidateMessage(hh.messages_url, msg);
                    } else if (actions.action_discard_url) {
                        await doNegotiationAction(actions.action_discard_url, actions.action_discard_method, msg || undefined);
                    } else {
                        console.warn(`${tag} ⚠ ${cn}: нет действия «отказ» на HH`);
                        if (msg && hh.messages_url) await sendCandidateMessage(hh.messages_url, msg);
                    }
                    await markSent(rowNumber, "отказ");
                }
                rejected++;
            }
        } catch (err: any) {
            failed++;
            console.error(`${tag} ✗ сбой по отклику ${negId}: ${err.message}`);
        }
    }
    console.log(`${tag} ${vacancy.vacancyName}: приглашений ${invited}, отказов ${rejected}, пропущено ${skipped}${failed ? `, сбоев ${failed}` : ""}`);
    return { invited, rejected, skipped };
}

export interface QuestionnaireInput {
    vacancyId: string;
    vacancyName: string;
    templatesUrl?: string | null;
}
export interface QuestionnaireSummary {
    total_forms: number;
    evaluated: number;
    passed: number;
    failed: number;
    skipped_no_match: number;
    skipped_processed: number;
    message: string;
}

/** Нормализованный ключ ФИО для дедупа (регистр, ё→е, схлопнутые пробелы). */
function fioKeyOf(name: string): string {
    return String(name || "").toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean).join(" ");
}
/** Чистит ФИО из формы: убирает хвосты «. Кандидат…», « - Инженер», «(…)», возраст/город. */
function cleanCandidateFio(raw: string): string {
    // мусор в начале («|Демин…») ломает сопоставление фамилии с HH
    let s = String(raw || "").replace(/^[^А-Яа-яЁёA-Za-z]+/, "").trim();
    s = s.split(/[.,(]|\s+[—-]\s+/)[0].trim();
    // Если строка начинается с 2–3 слов с заглавной (ФИО) — берём их, отсекая
    // хвосты вида «41 год Воронеж».
    const m = s.match(/^([А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){1,2})/);
    if (m) return m[1].trim();
    return s.replace(/\s+\d+\s*(год|года|лет|годиков|г)?\.?$/i, "").trim();
}
/** Множество уже записанных ФИО (ключи) из листа результатов — для дедупа fallback-записи. */
/**
 * ФИО уже записанных в лист кандидатов.
 * Возвращает null, если таблицу прочитать не удалось (квота Google, сеть). Раньше
 * тут отдавался пустой Set — и разовый сбой чтения превращался в дубли строк:
 * бот считал, что обработанных нет вообще, и записывал анкеты заново.
 */
async function readExistingFioKeys(spreadsheetId: string): Promise<Set<string> | null> {
    try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!A:AB` });
        const rows = resp.data.values || [];
        const hdr = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
        const fioIdx = hdr.indexOf("фио");
        if (fioIdx < 0) return new Set();
        return new Set(rows.slice(1).map((r) => fioKeyOf(String(r[fioIdx] || ""))).filter(Boolean));
    } catch {
        return null;
    }
}

export async function processVacancyQuestionnaire(vacancy: QuestionnaireInput): Promise<QuestionnaireSummary> {
    const tag = "[anketa]";
    const empty = (message: string): QuestionnaireSummary => ({
        total_forms: 0, evaluated: 0, passed: 0, failed: 0, skipped_no_match: 0, skipped_processed: 0, message,
    });
    const runToken = beginVacancyRun(vacancy.vacancyId);
    if (!canContinueVacancyRun(runToken)) return empty("вакансия приостановлена");

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return empty("нет templatesUrl");

    const anketaUrl = await readAnketaUrl(spreadsheetId);
    if (!anketaUrl) { console.log(`${tag} ${vacancy.vacancyName}: ссылка на анкету не указана`); return empty("нет ссылки на анкету"); }

    const form = await readFormResponses(anketaUrl);
    if (form.answers.length === 0) { console.log(`${tag} ${vacancy.vacancyName}: ответов в анкете нет`); return empty("нет ответов в анкете"); }
    if (!canContinueVacancyRun(runToken)) return empty("вакансия приостановлена");

    // настраиваем служебные колонки (Дата анализа анкеты + Действие HR с дропдауном/цветами)
    try {
        await ensureQuestionnaireColumns(spreadsheetId);
    } catch (e: any) {
        console.warn(`${tag} не смог настроить колонки анкеты: ${e.message}`);
    }

    const questionnaireWithoutStage = QUESTIONNAIRE_WITHOUT_STAGE_VACANCY_IDS.has(vacancy.vacancyId);
    // Анкету заполняют на «Первичном контакте», но пока ответ дойдёт до бота, кандидата
    // часто уже двигают дальше по воронке. Раньше пул ограничивался phone_interview —
    // такие анкеты не находили кандидата и падали в запись «без матча HH» (дубли строк
    // без ссылки на отклик). Поэтому смотрим и последующие стадии.
    const stages = ["phone_interview", "assessment", "interview", "offer", "hired"];
    if (questionnaireWithoutStage) stages.unshift("response", "consider");
    const acrossStages: HhNegotiation[] = [];
    for (const stage of stages) {
        if (!canContinueVacancyRun(runToken)) return empty("вакансия приостановлена");
        try {
            acrossStages.push(...await getAllNegotiationsByCollection(stage, vacancy.vacancyId));
        } catch (e: any) {
            console.warn(`${tag} стадия ${stage} недоступна: ${e.message}`);
        }
    }
    const candidates = [...new Map(acrossStages.map((candidate) => [String(candidate.id), candidate])).values()];

    const processed = await readProcessedNegotiationIds(spreadsheetId);
    const processedSources = readProcessedQuestionnaireSources();
    const knownFio = await readExistingFioKeys(spreadsheetId);
    // Без надёжного списка уже записанных ФИО запись «без матча HH» отключаем —
    // лучше пропустить цикл, чем наплодить дубли.
    const fioSetReliable = knownFio !== null;
    const existingFioSet = knownFio || new Set<string>();
    if (!fioSetReliable) console.warn(`${tag} ${vacancy.vacancyName}: не прочитал лист результатов — запись без матча HH отключена на этот цикл`);
    const templates = QUESTIONNAIRE_HH_ACTIONS_ENABLED ? await readTemplates(spreadsheetId) : [];

    console.log(`${tag} ${vacancy.vacancyName}: ответов ${form.answers.length}, кандидатов в воронке ${candidates.length}, вопросов ${form.questions.length}`);

    // Ленивая карта телефон → кандидат (строим только если матч по имени не сработал).
    // Телефоны берём из полного резюме кандидата.
    let phoneMap: Map<string, HhNegotiation> | null = null;
    const buildPhoneMap = async (): Promise<Map<string, HhNegotiation>> => {
        if (phoneMap) return phoneMap;
        phoneMap = new Map();
        for (const c of candidates) {
            if (!canContinueVacancyRun(runToken)) break;
            if (!c.resume?.id) continue;
            try {
                const resume = await getResume(c.resume.id, c.id, vacancy.vacancyId);
                const phone = extractPhoneFromResume(resume);
                if (phone) phoneMap.set(phone, c);
            } catch { /* пропускаем недоступные резюме */ }
        }
        return phoneMap;
    };

    let evaluated = 0, passed = 0, failed = 0, skippedNoMatch = 0, skippedProcessed = 0;

    const minDate = anketaMinDate(vacancy.vacancyId);
    if (minDate) console.log(`${tag} ${vacancy.vacancyName}: берём анкеты не раньше ${minDate}`);
    let skippedOld = 0;

    for (const ans of form.answers) {
        if (!canContinueVacancyRun(runToken)) {
            console.log(`${tag} ${vacancy.vacancyName}: приостановлена — оставшиеся анкеты не анализируются`);
            break;
        }
        if (processedSources.has(ans.sourceKey)) {
            skippedProcessed++;
            continue;
        }
        // Старые анкеты (до отсечки) не трогаем — их разбирали вручную.
        if (minDate && ans.submittedAt && ans.submittedAt < minDate) {
            skippedOld++;
            continue;
        }

        const candidateByName = matchCandidate(ans.name, candidates);
        const formPhone = normPhone(ans.phone);
        let cand: HhNegotiation | null = candidateByName;

        // Для архивной вакансии кандидаты остаются в «Отклик/Подумать».
        // Здесь требуем одновременно уникальное совпадение ФИО и точный телефон,
        // чтобы не повторить ошибку с привязкой чужой анкеты.
        if (questionnaireWithoutStage) {
            if (!candidateByName || !candidateByName.resume?.id || formPhone.length < 10) {
                cand = null;
                console.log(`${tag} • "${ans.name}" — для этой вакансии нужны точные ФИО и телефон, пропуск`);
            } else {
                try {
                    const resume = await getResume(
                        candidateByName.resume.id,
                        candidateByName.id,
                        vacancy.vacancyId,
                    );
                    const candidatePhone = extractPhoneFromResume(resume);
                    if (!candidatePhone || candidatePhone !== formPhone) {
                        cand = null;
                        console.log(`${tag} • "${ans.name}" — ФИО найдено, но телефон не совпал, пропуск`);
                    } else {
                        cand = candidateByName;
                        console.log(`${tag} • "${ans.name}" сопоставлен по ФИО и телефону`);
                    }
                } catch (e: any) {
                    cand = null;
                    console.log(`${tag} • "${ans.name}" — не удалось проверить телефон: ${e.message}`);
                }
            }
        // Если в форме указан полноценный телефон, он обязателен для матчинга.
        // Совпадение только по ФИО при несовпадающем телефоне запрещено.
        } else if (formPhone.length >= 10) {
            const pm = await buildPhoneMap();
            const candidateByPhone = pm.get(formPhone) || null;

            if (!candidateByPhone) {
                cand = null;
                console.log(`${tag} • "${ans.name}" — телефон из анкеты не совпал ни с одним кандидатом, пропуск`);
            } else if (candidateByName && candidateByName.id !== candidateByPhone.id) {
                cand = null;
                console.log(`${tag} • "${ans.name}" — конфликт ФИО и телефона, пропуск`);
            } else {
                cand = candidateByPhone;
                console.log(`${tag} • "${ans.name}" сопоставлен по телефону`);
            }
        }
        if (!cand) {
            // Fallback: анкету всё равно анализируем и пишем по ФИО (без действий на HH).
            // Так новые анкеты не теряются, даже если кандидата нет в нужной стадии.
            const fio = cleanCandidateFio(ans.name);
            const fioKey = fioKeyOf(fio);
            if (fioKey.split(" ").filter(Boolean).length < 2) {
                console.log(`${tag} • "${ans.name}" — нет матча и ФИО неполное, пропуск`);
                skippedNoMatch++;
                continue;
            }
            if (!fioSetReliable) { skippedProcessed++; continue; }
            if (existingFioSet.has(fioKey)) { skippedProcessed++; continue; }
            const rlink = /^https?:\/\//i.test(ans.resumeUrl || "") ? String(ans.resumeUrl) : "";
            try {
                const result = await evaluateQuestionnaire(vacancy.vacancyName, ans);
                if (!canContinueVacancyRun(runToken)) {
                    console.log(`${tag} • ${fio}: вакансия приостановлена во время анализа — результат отброшен`);
                    break;
                }
                await appendTestTaskResult(spreadsheetId, rlink, result, fio);
                markQuestionnaireSourceProcessed(ans.sourceKey, vacancy.vacancyId, "");
                processedSources.add(ans.sourceKey);
                existingFioSet.add(fioKey);
                evaluated++;
                if (result.verdict === "Прошёл") passed++; else failed++;
                console.log(`${tag} • ${fio} (без матча HH) → ${result.avgScore} → ${result.verdict}`);
            } catch (err: any) {
                console.error(`${tag} ошибка (без матча) по "${ans.name}": ${err.message}`);
            }
            continue;
        }
        const negotiationId = cand.id;
        if (processed.has(String(negotiationId))) {
            markQuestionnaireSourceProcessed(ans.sourceKey, vacancy.vacancyId, String(negotiationId));
            processedSources.add(ans.sourceKey);
            skippedProcessed++;
            continue;
        }
        const resumeUrl = cand.resume?.id
            ? `https://hh.ru/resume/${cand.resume.id}?t=${negotiationId}`
            : cand.resume?.alternate_url || "";
        try {
            const result = await evaluateQuestionnaire(vacancy.vacancyName, ans);
            if (!canContinueVacancyRun(runToken)) {
                console.log(`${tag} • ${ans.name}: вакансия приостановлена во время анализа — результат отброшен`);
                break;
            }
            await appendTestTaskResult(spreadsheetId, resumeUrl, result, hhCandidateName(cand));
            markQuestionnaireSourceProcessed(ans.sourceKey, vacancy.vacancyId, String(negotiationId));
            processedSources.add(ans.sourceKey);
            processed.add(String(negotiationId));
            existingFioSet.add(fioKeyOf(hhCandidateName(cand)));
            // Анкета ТОЛЬКО оценивает и пишет в таблицу. Действия на HH — по решению HR
            // в колонке «Действие HR» (см. processAnketaHrDecisions ниже).
            evaluated++;
            if (result.verdict === "Прошёл") passed++; else failed++;
            console.log(`${tag} • ${ans.name} → ${result.avgScore} → ${result.verdict}`);
        } catch (err: any) {
            console.error(`${tag} ошибка по "${ans.name}": ${err.message}`);
        }
    }

    if (!canContinueVacancyRun(runToken)) {
        console.log(`${tag} ${vacancy.vacancyName}: дальнейшие действия остановлены`);
    } else if (!QUESTIONNAIRE_HH_ACTIONS_ENABLED) {
        console.log(`${tag} HH-actions for questionnaire are disabled (QUESTIONNAIRE_HH_ACTIONS != true)`);
    } else {
        try {
            await processAnketaHrDecisions(vacancy, { dryRun: process.env.ANKETA_HR_DRY_RUN !== "false" });
        } catch (e: any) {
            console.error(`${tag} ошибка обработки решений HR: ${e.message}`);
        }
    }

    return {
        total_forms: form.answers.length,
        evaluated, passed, failed,
        skipped_no_match: skippedNoMatch,
        skipped_processed: skippedProcessed,
        message: `Анкеты: оценено ${evaluated} (прошли ${passed}, нет ${failed}), без матча ${skippedNoMatch}, уже обработано ${skippedProcessed}${skippedOld ? `, старых пропущено ${skippedOld}` : ""}`,
    };
}
