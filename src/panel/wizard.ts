/**
 * Пошаговое создание вакансии.
 *
 * Сервисный аккаунт не может завести Google-таблицу сам (у него нет своего
 * Диска), поэтому таблицу создаёт человек и даёт на неё доступ. Всё остальное
 * мастер делает за него: заводит нужные листы с правильными заголовками,
 * заполняет вопрос-ответ, автоответы и фильтры, при желании создаёт анкету
 * и добавляет вакансию в реестр.
 */
import { sheets } from "../google/sheets.client";
import { createVacancy } from "./registry";
import { createForm } from "./forms";

const SHEET_QA = "Вопрос-ответ";
const SHEET_TEMPLATES = "Автоответы";
const SHEET_FILTERS = "Доп. фильтры";
const SHEET_ANALYSIS = "ИИ анализ резюме";
const SHEET_TESTTASK = "ИИ анализ тестового задания";

/** Заголовки листов — ровно как в рабочих таблицах бота. */
const LAYOUT: Record<string, string[]> = {
    [SHEET_QA]: ["Вопрос", "Ответ"],
    [SHEET_TEMPLATES]: ["Условие, когда отправлять", "Тип", "Текст", "действие"],
    [SHEET_FILTERS]: ["Фильтр", "Анкета"],
    [SHEET_ANALYSIS]: ["Ссылка на резюме", "Комментарии ИИ", "Балл", "Статус", "Дата обработки", "ФИО"],
};

/**
 * Лист анкет: между ссылкой и заключением идёт по колонке на каждый вопрос.
 * Нумерация начинается с 3 — так их называет разбор анкет (`num = i + 3`),
 * и если колонок не хватит, ответы просто некуда будет записать.
 */
export function testTaskHeaders(questionCount: number): string[] {
    const qs: string[] = [];
    for (let i = 0; i < Math.max(0, questionCount); i++) qs.push(`Ответ на ${i + 3} вопрос`);
    return [
        "Ссылка на резюме",
        ...qs,
        "Совокупное заключение", "Итоговый балл", "Дата анализа анкеты",
        "Действие HR", "ФИО", "Отправлено",
    ];
}

/** Сколько вопросов в Google-форме — той же логикой, что и разбор анкет. */
const SERVICE_RE = /отметка времени|краткий коммент|^статус$|адрес электронной почты|e-?mail|почта/i;
const NAME_RE = /фио|фамили|как вас зовут|представьтесь|ваше\s*(полное\s*)?имя|ваши\s+фамили|напишите\s+ваши/i;
const PHONE_RE = /телефон|моб\.|phone/i;

export async function countFormQuestions(anketaUrl: string): Promise<number> {
    const id = extractSpreadsheetId(anketaUrl);
    if (!id) return 0;
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
        const first = meta.data.sheets?.[0]?.properties?.title;
        if (!first) return 0;
        const d = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${first}!A1:BZ1` });
        const raw = (d.data.values?.[0] || []).map((x: any) => String(x || "").trim());
        const kept = raw.map((title, colIndex) => ({ title, colIndex }))
            .filter((k) => k.title && k.title.toLowerCase() !== "вопрос без заголовка");
        const resumeCol = raw.findIndex((h) => /резюме|resume/i.test(h));
        const nameByHeader = raw.findIndex((h) => NAME_RE.test(h));
        const phoneByHeader = raw.findIndex((h) => PHONE_RE.test(h));
        const nameCol = nameByHeader >= 0 ? nameByHeader : (kept[1]?.colIndex ?? 1);
        let phoneCol: number;
        if (phoneByHeader >= 0) phoneCol = phoneByHeader;
        else {
            const fb = kept[2]?.colIndex ?? 2;
            phoneCol = SERVICE_RE.test(raw[fb] || "") ? -1 : fb;
        }
        const skip = new Set([nameCol, phoneCol, resumeCol].filter((x) => x >= 0));
        return kept.filter((k) => !skip.has(k.colIndex) && !SERVICE_RE.test(k.title)).length;
    } catch {
        return 0;
    }
}

export const extractSpreadsheetId = (url: string): string =>
    String(url || "").match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] || "";

/** Готовые тексты писем — HR останется подставить свои ссылки. */
export function defaultTemplates(companyName = "компания") {
    const sign = `\n\nС уважением,\n${companyName}`;
    return [
        {
            condition: "Успешно", type: "Резюме", action: "Перевод в стадию подумать",
            text: `Здравствуйте, [Name]!\n\nБольшое спасибо за интерес, проявленный к вакансии "[Vacancy]". Для дальнейшего рассмотрения Вашего резюме заполните небольшую анкету:\n[АНКЕТА]${sign}`,
        },
        {
            condition: "Отказ", type: "Резюме", action: "Перевод в стадию отказ",
            text: `Здравствуйте, [Name]!\n\nБольшое спасибо за интерес, проявленный к вакансии "[Vacancy]". К сожалению, в настоящий момент мы не готовы пригласить Вас на дальнейшее интервью по этой вакансии. Мы внимательно ознакомились с Вашим резюме и, возможно, вернёмся к Вашей кандидатуре, когда у нас появится подходящая позиция.${sign}`,
        },
        {
            condition: "Успешно", type: "Тестовое задание", action: "Приглашение на собеседование",
            text: `Здравствуйте, [Name]!\n\nБлагодарим Вас за заполненную анкету. Ваши ответы нам понравились, и мы приглашаем Вас на собеседование.\n\nНапишите, пожалуйста, в какое время Вам удобно подъехать.${sign}`,
        },
        {
            condition: "Отказ", type: "Тестовое задание", action: "Перевод в стадию отказ",
            text: `Здравствуйте, [Name]!\n\nБлагодарим Вас за заполненную анкету. К сожалению, в настоящий момент мы не готовы продолжить общение по этой вакансии. Возможно, вернёмся к Вашей кандидатуре позже.${sign}`,
        },
    ];
}

export interface SheetCheck {
    ok: boolean;
    title?: string;
    url?: string;
    sheets?: { name: string; exists: boolean; filled: boolean; rows: number }[];
    error?: string;
    hint?: string;
}

/** Шаг 1: доступна ли таблица и что в ней уже есть. */
export async function checkSpreadsheet(url: string): Promise<SheetCheck> {
    const id = extractSpreadsheetId(url);
    if (!id) return { ok: false, error: "Это не похоже на ссылку Google-таблицы", hint: "Ссылка должна содержать /spreadsheets/d/…" };

    let meta: any;
    try {
        meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    } catch (e: any) {
        const msg = String(e?.message || e);
        if (/permission|403/i.test(msg)) {
            return {
                ok: false,
                error: "Нет доступа к таблице",
                hint: "Откройте таблицу → «Настройки доступа» → добавьте openclaw@aerobic-cosmos-488918-k2.iam.gserviceaccount.com как Редактора.",
            };
        }
        if (/not found|404/i.test(msg)) return { ok: false, error: "Таблица не найдена", hint: "Проверьте ссылку." };
        return { ok: false, error: msg.slice(0, 200) };
    }

    const existing: string[] = meta.data.sheets.map((s: any) => s.properties.title);
    const result: SheetCheck["sheets"] = [];
    for (const name of Object.keys(LAYOUT)) {
        const exists = existing.includes(name);
        let rows = 0;
        if (exists) {
            try {
                const d = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${name}!A1:A` });
                rows = Math.max(0, (d.data.values?.length || 0) - 1);
            } catch { /* лист есть, но пустой */ }
        }
        result.push({ name, exists, filled: rows > 0, rows });
    }
    return { ok: true, title: meta.data.properties.title, url: `https://docs.google.com/spreadsheets/d/${id}/edit`, sheets: result };
}

export interface WizardPayload {
    templatesUrl: string;
    name: string;
    hhUrl: string;
    responsible: string;
    account: string;
    qa: { question: string; answer: string }[];
    templates: { condition: string; type: string; text: string; action?: string }[];
    filters: string[];
    /** анкета: создать новую в панели, взять ссылку на Google-форму или отложить */
    anketaMode: "create" | "link" | "later";
    anketaUrl?: string;
    anketaTitle?: string;
    anketaQuestions?: any[];
}

async function ensureSheet(spreadsheetId: string, name: string, headers: string[], existing: string[]) {
    if (!existing.includes(name)) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
        });
    }
    const cur = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${name}!A1:Z1` });
    const head = (cur.data.values?.[0] || []).map((x: any) => String(x || "").trim()).filter(Boolean);
    if (head.length === 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${name}!A1`,
            valueInputOption: "RAW",
            requestBody: { values: [headers] },
        });
    }
}

/**
 * Дописывает недостающие колонки «Ответ на N вопрос» в уже существующий лист.
 * Вставляет их перед «Совокупное заключение», чтобы не разъехались данные:
 * запись идёт по именам заголовков, но порядок важен для чтения человеком.
 */
export async function syncTestTaskColumns(spreadsheetId: string, questionCount: number) {
    if (questionCount <= 0) return { added: 0 };
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = meta.data.sheets.find((s: any) => s.properties.title === SHEET_TESTTASK);
    if (!sheet) return { added: 0 };

    const d = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_TESTTASK}!A1:BZ1` });
    const head = (d.data.values?.[0] || []).map((x: any) => String(x || "").trim());
    if (!head.length) return { added: 0 };

    const have = new Set(head.filter((h) => /^Ответ на \d+ вопрос$/i.test(h)));
    const need: string[] = [];
    for (let i = 0; i < questionCount; i++) {
        const title = `Ответ на ${i + 3} вопрос`;
        if (!have.has(title)) need.push(title);
    }
    if (!need.length) return { added: 0 };

    // вставляем перед «Совокупное заключение», а если его нет — в конец
    let at = head.findIndex((h) => /^Совокупное заключение$/i.test(h));
    if (at < 0) at = head.length;

    await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
            requests: [{
                insertDimension: {
                    range: { sheetId: sheet.properties.sheetId, dimension: "COLUMNS", startIndex: at, endIndex: at + need.length },
                    inheritFromBefore: true,
                },
            }],
        },
    });
    const colLetter = (n: number) => { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_TESTTASK}!${colLetter(at)}1:${colLetter(at + need.length - 1)}1`,
        valueInputOption: "RAW",
        requestBody: { values: [need] },
    });
    return { added: need.length };
}

/** Финальный шаг: разложить всё по листам и завести вакансию. */
export async function buildVacancy(p: WizardPayload) {
    const spreadsheetId = extractSpreadsheetId(p.templatesUrl);
    if (!spreadsheetId) throw new Error("не указана таблица");
    if (!String(p.name || "").trim()) throw new Error("не указано название вакансии");
    if (!/\/vacancy\/\d+/.test(String(p.hhUrl || ""))) throw new Error("в ссылке на HH нет /vacancy/<id>");

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existing: string[] = meta.data.sheets.map((s: any) => s.properties.title);
    const log: string[] = [];

    // Анкету определяем ПЕРВОЙ: от числа её вопросов зависит, сколько колонок
    // «Ответ на N вопрос» завести в листе разбора анкет.
    let anketaUrl = String(p.anketaUrl || "").trim();
    let createdForm: any = null;
    let questionCount = 0;

    if (p.anketaMode === "create") {
        const questions = (p.anketaQuestions || []).filter((q: any) => String(q?.title || "").trim());
        createdForm = await createForm({
            title: String(p.anketaTitle || `Анкета — ${p.name}`),
            vacancyName: p.name,
            questions,
            status: "published",
        });
        anketaUrl = `/anketa/${createdForm.publicId}`;
        questionCount = questions.length;
        log.push(`анкета создана: ${questionCount} вопрос(ов)`);
    } else if (p.anketaMode === "link" && anketaUrl) {
        questionCount = await countFormQuestions(anketaUrl);
        log.push(questionCount
            ? `в Google-форме найдено вопросов: ${questionCount}`
            : "не удалось посчитать вопросы формы — колонки ответов не создаю");
    }

    for (const [name, headers] of Object.entries(LAYOUT)) {
        await ensureSheet(spreadsheetId, name, headers, existing);
    }
    await ensureSheet(spreadsheetId, SHEET_TESTTASK, testTaskHeaders(questionCount), existing);
    log.push(`листы проверены: ${Object.keys(LAYOUT).length + 1}`);
    // лист мог существовать раньше с другим числом вопросов — дополняем
    const synced = await syncTestTaskColumns(spreadsheetId, questionCount);
    if (questionCount) {
        log.push(synced.added
            ? `колонки ответов дополнены: +${synced.added}`
            : `колонки «Ответ на 3…${questionCount + 2} вопрос» на месте`);
    }

    // вопрос-ответ
    const qa = (p.qa || []).filter((x) => String(x?.question || "").trim() && String(x?.answer || "").trim());
    if (qa.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${SHEET_QA}!A2`,
            valueInputOption: "RAW",
            requestBody: { values: qa.map((x) => [x.question.trim(), x.answer.trim()]) },
        });
        log.push(`вопрос-ответ: ${qa.length}`);
    }

    // автоответы: [АНКЕТА] заменяем реальной ссылкой
    const fullAnketa = anketaUrl.startsWith("/") ? `${process.env.PUBLIC_ORIGIN || "https://guidoai.kbmyproject.ru"}${anketaUrl}` : anketaUrl;
    const tpl = (p.templates || []).filter((t) => String(t?.text || "").trim());
    if (tpl.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${SHEET_TEMPLATES}!A2`,
            valueInputOption: "RAW",
            requestBody: {
                values: tpl.map((t) => [
                    t.condition, t.type,
                    String(t.text).replace(/\[АНКЕТА\]/g, fullAnketa || "[ссылка на анкету]"),
                    t.action || "",
                ]),
            },
        });
        log.push(`шаблоны писем: ${tpl.length}`);
    }

    // фильтры + ссылка на анкету во второй колонке
    const filters = (p.filters || []).map((f) => String(f || "").trim()).filter(Boolean);
    const rows: string[][] = [];
    const maxLen = Math.max(filters.length, fullAnketa ? 1 : 0);
    for (let i = 0; i < maxLen; i++) rows.push([filters[i] || "", i === 0 ? fullAnketa : ""]);
    if (rows.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${SHEET_FILTERS}!A2`,
            valueInputOption: "RAW",
            requestBody: { values: rows },
        });
        log.push(`фильтры: ${filters.length}`);
    }

    // и только теперь — в реестр, чтобы бот увидел уже готовую таблицу
    const created = await createVacancy({
        name: p.name,
        hhUrl: p.hhUrl,
        templatesUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        responsible: p.responsible,
        account: p.account,
    });
    if (!created.ok) throw new Error(created.error || "не удалось добавить вакансию в реестр");
    log.push(`вакансия добавлена в реестр, ID ${created.vacancyId}`);

    return {
        ok: true,
        vacancyId: created.vacancyId,
        row: created.row,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        anketaUrl: fullAnketa || null,
        formId: createdForm?.id || null,
        log,
    };
}
