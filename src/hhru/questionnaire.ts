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
    getPhoneInterviewResponses,
    getResume,
    extractActions,
    sendCandidateMessage,
    doNegotiationAction,
    getNegotiation,
    type HhNegotiation,
} from "./hh-api";
import { askAi, parseAiJsonText } from "./ai-scorer";
import { extractSpreadsheetId, readTemplates, findTemplate, fillTemplate } from "./sheets-analysis";
import { registerInterviewConversation } from "./interview-chat";
import { getInterviewChatState, updateInterviewChatState } from "./interview-chat.store";

const FILTERS_SHEET = "Доп. фильтры";
const RESULT_SHEET = "ИИ анализ тестового задания";
const EMPTY_HEADERS = ["", "вопрос без заголовка"];
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
    answers: { num: number; title: string; answer: string }[];
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

    // kept[0]=отметка времени, kept[1]=имя, kept[2]=телефон, kept[3+]=вопросы (нумерация = индекс в kept)
    const nameCol = kept[1]?.colIndex ?? 1;
    const phoneCol = kept[2]?.colIndex ?? 2;
    const questions: FormQuestion[] = kept
        .map((k, idx) => ({ ...k, num: idx }))
        .filter((k) => k.num >= 3)
        .map((k) => ({ num: k.num, title: k.title, colIndex: k.colIndex }));

    const answers: FormAnswer[] = rows.slice(1)
        .filter((row) => row.some((c) => String(c || "").trim()))
        .map((row) => ({
            name: String(row[nameCol] || "").trim(),
            phone: String(row[phoneCol] || "").trim(),
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
    if (formTokens.length === 0) return null;

    // сколько слов должно совпасть: 1 слово в форме → 1; 2 и больше → минимум 2 (фамилия+имя),
    // чтобы опечатка в отчестве не ломала матч
    const need = formTokens.length >= 2 ? 2 : 1;

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
export async function ensureQuestionnaireColumns(spreadsheetId: string): Promise<void> {
    await ensureAnalysisDateColumn(spreadsheetId); // сначала дата
    await ensureHrDecisionColumn(spreadsheetId);   // потом решение (в конце)
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
    result: QuestionnaireResult
): Promise<void> {
    const headers = await getResultHeaders(spreadsheetId);
    if (headers.length === 0) throw new Error(`лист "${RESULT_SHEET}" не найден или без заголовков`);

    const row = new Array(headers.length).fill("");
    headers.forEach((h, i) => {
        const hl = h.toLowerCase();
        if (hl === "ссылка на резюме") {
            row[i] = resumeUrl;
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

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${RESULT_SHEET}!A:A`,
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
    const dryRun = options.dryRun !== false;
    const tag = dryRun ? "[anketa-hr:DRY]" : "[anketa-hr:LIVE]";
    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return { invited: 0, rejected: 0, skipped: 0 };

    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${RESULT_SHEET}!A:Z` });
    const rows = (resp.data.values || []) as string[][];
    if (rows.length < 2) return { invited: 0, rejected: 0, skipped: 0 };
    const headers = rows[0].map((h) => String(h || "").trim().toLowerCase());
    const linkIdx = headers.findIndex((h) => h === "ссылка на резюме");
    const hrIdx = headers.findIndex((h) => h === HR_DECISION_HEADER.toLowerCase());
    if (linkIdx === -1 || hrIdx === -1) return { invited: 0, rejected: 0, skipped: 0 };

    const templates = dryRun ? [] : await readTemplates(spreadsheetId);
    let invited = 0, rejected = 0, skipped = 0;

    for (const row of rows.slice(1)) {
        const decision = String(row[hrIdx] || "").trim();
        if (decision !== "Подходит" && decision !== "Не подходит") continue;
        const link = String(row[linkIdx] || "");
        const negId = (link.match(/[?&]t=([^&]+)/) || [])[1] || "";
        if (!negId) continue;

        const hh = await getNegotiation(negId);
        if (!hh) { skipped++; continue; }
        const cn = hhCandidateName(hh);
        const sid = String(hh.state?.id || "");
        const alreadyDiscarded = sid.startsWith("discard") || hh.state?.name === "Отказ";
        const alreadyInvited = !!getInterviewChatState(negId);
        // Кого уже тронули по старой схеме (пригласили ИЛИ отклонили) — НЕ трогаем, оставляем как есть.
        // Новая схема по «Действие HR» применяется только к ещё не обработанным кандидатам.
        if (alreadyInvited || alreadyDiscarded) { skipped++; continue; }

        if (decision === "Подходит") {
            console.log(`${tag} ✉ ПРИГЛАШЕНИЕ: ${vacancy.vacancyName} / ${cn}`);
            if (!dryRun) {
                const tpl = findTemplate(templates, "Успешно", "Тестовое задание");
                const msg = tpl ? fillTemplate(tpl.text, cn, vacancy.vacancyName) : "";
                if (msg && hh.messages_url) await sendCandidateMessage(hh.messages_url, msg);
                await registerInterviewConversation(vacancy, hh);
            }
            invited++;
        } else {
            const actions = extractActions(hh);
            if (!actions.action_discard_url) { skipped++; continue; }
            console.log(`${tag} ✗ ОТКАЗ: ${vacancy.vacancyName} / ${cn}`);
            if (!dryRun) {
                const tpl = findTemplate(templates, "Отказ", "Тестовое задание");
                const msg = tpl ? fillTemplate(tpl.text, cn, vacancy.vacancyName) : "";
                await doNegotiationAction(actions.action_discard_url, actions.action_discard_method, msg || undefined);
            }
            rejected++;
        }
    }
    console.log(`${tag} ${vacancy.vacancyName}: приглашений ${invited}, отказов ${rejected}, пропущено ${skipped}`);
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

export async function processVacancyQuestionnaire(vacancy: QuestionnaireInput): Promise<QuestionnaireSummary> {
    const tag = "[anketa]";
    const empty = (message: string): QuestionnaireSummary => ({
        total_forms: 0, evaluated: 0, passed: 0, failed: 0, skipped_no_match: 0, skipped_processed: 0, message,
    });

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return empty("нет templatesUrl");

    const anketaUrl = await readAnketaUrl(spreadsheetId);
    if (!anketaUrl) { console.log(`${tag} ${vacancy.vacancyName}: ссылка на анкету не указана`); return empty("нет ссылки на анкету"); }

    const form = await readFormResponses(anketaUrl);
    if (form.answers.length === 0) { console.log(`${tag} ${vacancy.vacancyName}: ответов в анкете нет`); return empty("нет ответов в анкете"); }

    // настраиваем служебные колонки (Дата анализа анкеты + Действие HR с дропдауном/цветами)
    try {
        await ensureQuestionnaireColumns(spreadsheetId);
    } catch (e: any) {
        console.warn(`${tag} не смог настроить колонки анкеты: ${e.message}`);
    }

    const candidates = await getPhoneInterviewResponses(vacancy.vacancyId);
    const processed = await readProcessedNegotiationIds(spreadsheetId);
    const templates = QUESTIONNAIRE_HH_ACTIONS_ENABLED ? await readTemplates(spreadsheetId) : [];

    console.log(`${tag} ${vacancy.vacancyName}: ответов ${form.answers.length}, в «первичном контакте» ${candidates.length}, вопросов ${form.questions.length}`);

    // Ленивая карта телефон → кандидат (строим только если матч по имени не сработал).
    // Телефоны берём из полного резюме кандидата.
    let phoneMap: Map<string, HhNegotiation> | null = null;
    const buildPhoneMap = async (): Promise<Map<string, HhNegotiation>> => {
        if (phoneMap) return phoneMap;
        phoneMap = new Map();
        for (const c of candidates) {
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

    for (const ans of form.answers) {
        let cand = matchCandidate(ans.name, candidates);
        // если по имени не сошлось — пробуем по телефону
        if (!cand && ans.phone) {
            const fp = normPhone(ans.phone);
            if (fp.length >= 10) {
                const pm = await buildPhoneMap();
                cand = pm.get(fp) || null;
                if (cand) console.log(`${tag} • "${ans.name}" сопоставлен по телефону`);
            }
        }
        if (!cand) {
            console.log(`${tag} • "${ans.name}" — не сопоставлен с кандидатом из «первичного контакта», пропуск`);
            skippedNoMatch++;
            continue;
        }
        const negotiationId = cand.id;
        if (processed.has(String(negotiationId))) {
            skippedProcessed++;
            continue;
        }
        const resumeUrl = cand.resume?.id
            ? `https://hh.ru/resume/${cand.resume.id}?t=${negotiationId}`
            : cand.resume?.alternate_url || "";
        try {
            const result = await evaluateQuestionnaire(vacancy.vacancyName, ans);
            await appendTestTaskResult(spreadsheetId, resumeUrl, result);
            // Анкета ТОЛЬКО оценивает и пишет в таблицу. Действия на HH — по решению HR
            // в колонке «Действие HR» (см. processAnketaHrDecisions ниже).
            evaluated++;
            if (result.verdict === "Прошёл") passed++; else failed++;
            console.log(`${tag} • ${ans.name} → ${result.avgScore} → ${result.verdict}`);
        } catch (err: any) {
            console.error(`${tag} ошибка по "${ans.name}": ${err.message}`);
        }
    }

    if (!QUESTIONNAIRE_HH_ACTIONS_ENABLED) {
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
        message: `Анкеты: оценено ${evaluated} (прошли ${passed}, нет ${failed}), без матча ${skippedNoMatch}, уже обработано ${skippedProcessed}`,
    };
}
