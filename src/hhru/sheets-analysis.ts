/**
 * Работа с Google-таблицей вакансии (templatesUrl).
 * Листы: «ИИ анализ резюме», «Доп. фильтры», «Автоответы».
 * Перенос нод n8n «Записываем ИИ анализ», «Get row(s) in sheet», «Ищем ручные решения».
 */
import { sheets } from "../google/sheets.client";

/** Достаёт spreadsheetId из ссылки на Google-таблицу */
export function extractSpreadsheetId(url: string): string {
    const m = String(url || "").match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : "";
}

const SHEET_ANALYSIS = "ИИ анализ резюме";
const SHEET_FILTERS = "Доп. фильтры";
const SHEET_TEMPLATES = "Автоответы";

/** Читает лист как массив объектов {заголовок: значение} */
async function readSheetObjects(spreadsheetId: string, sheetName: string): Promise<Record<string, any>[]> {
    try {
        const resp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:Z`,
        });
        const rows = resp.data.values || [];
        if (rows.length < 2) return [];
        const headers = rows[0].map((h) => String(h).trim());
        return rows.slice(1).map((row, idx) => {
            const obj: Record<string, any> = { row_number: idx + 2 };
            headers.forEach((h, i) => {
                obj[h] = row[i] ?? "";
            });
            return obj;
        });
    } catch (err: any) {
        console.warn(`[sheets] не смог прочитать лист "${sheetName}": ${err.message}`);
        return [];
    }
}

export interface AnalysisRow {
    resume_url: string;
    ai_comment: string;
    score: number | "";
    status: string;
    processed_date?: string; // дата обработки ботом, отформатированная
}

/** Гарантирует заголовок E «Дата обработки» (мигрирует старую «Дата отклика») */
async function ensureProcessedHeader(spreadsheetId: string): Promise<void> {
    try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_ANALYSIS}!E1` });
        const cur = String(resp.data.values?.[0]?.[0] || "").trim();
        if (cur === "" || cur === "Дата отклика") {
            await sheets.spreadsheets.values.update({
                spreadsheetId, range: `${SHEET_ANALYSIS}!E1`,
                valueInputOption: "USER_ENTERED", requestBody: { values: [["Дата обработки"]] },
            });
        }
    } catch { /* лист может отсутствовать — молча пропускаем */ }
}

/** Добавляет строку с результатом ИИ-анализа в лист «ИИ анализ резюме» */
export async function appendAnalysis(spreadsheetId: string, data: AnalysisRow): Promise<void> {
    await ensureProcessedHeader(spreadsheetId);
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEET_ANALYSIS}!A:E`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [[data.resume_url, data.ai_comment, data.score, data.status, data.processed_date || ""]],
        },
    });
}

/**
 * Обновляет строку кандидата по negotiation_id (из ссылки ?t=...) или добавляет новую.
 * Если в существующей строке HR уже поставил решение («Подходит»/«Отказ») — НЕ перезаписываем.
 */
export async function upsertAnalysis(spreadsheetId: string, data: AnalysisRow, negotiationId: string): Promise<void> {
    const rows = await readAnalysisRows(spreadsheetId);
    const existing = rows.find((r) => {
        const link = String(r["Ссылка на резюме"] || "");
        const m = link.match(/[?&]t=([^&]+)/);
        return m && m[1] === String(negotiationId);
    });

    if (existing) {
        const status = String(existing["Статус"] || "").trim();
        // HR уже принял решение — не трогаем строку
        if (status === "Подходит" || status === "Отказ") return;

        const rowNum = existing.row_number as number;
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${SHEET_ANALYSIS}!A${rowNum}:E${rowNum}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[data.resume_url, data.ai_comment, data.score, data.status, data.processed_date || ""]] },
        });
        return;
    }

    await appendAnalysis(spreadsheetId, data);
}

/** Доп. фильтры заказчика + минимальный балл (одна строка/первая значимая) */
export async function readFilters(spreadsheetId: string): Promise<{ filter: string; minScore: number }> {
    const rows = await readSheetObjects(spreadsheetId, SHEET_FILTERS);
    let filter = "";
    let minScore = 7;
    for (const row of rows) {
        const f = row["Фильтр"] || row["Фильтры"] || row["filter"] || row["filters"] || "";
        const m = row["Минимальный балл"] || row["Мин. балл"] || row["min_score"] || row["minScore"];
        if (f && !filter) filter = String(f);
        const num = Number(m);
        if (!Number.isNaN(num) && m !== "" && m !== undefined) minScore = num;
    }
    return { filter, minScore };
}

export interface AutoReplyTemplate {
    condition: string; // «Успешно» | «Отказ» | ...
    type: string; // «Резюме» | ...
    text: string;
}

/** Шаблоны автоответов из листа «Автоответы» */
export async function readTemplates(spreadsheetId: string): Promise<AutoReplyTemplate[]> {
    const rows = await readSheetObjects(spreadsheetId, SHEET_TEMPLATES);
    return rows
        .filter((r) => r["Условие, когда отправлять"] && r["Тип"] && r["Текст"])
        .map((r) => ({
            condition: String(r["Условие, когда отправлять"]).trim(),
            type: String(r["Тип"]).trim(),
            text: String(r["Текст"]),
        }));
}

/** Находит шаблон по условию и типу (регистронезависимо) */
export function findTemplate(templates: AutoReplyTemplate[], condition: string, type: string): AutoReplyTemplate | undefined {
    const norm = (s: string) => s.trim().toLowerCase();
    return templates.find((t) => norm(t.condition) === norm(condition) && norm(t.type) === norm(type));
}

/** Подстановка [Name] и [Vacancy] в текст шаблона */
export function fillTemplate(text: string, candidateName: string, vacancyName: string): string {
    return String(text || "")
        .replaceAll("[Name]", candidateName || "")
        .replaceAll("[Vacancy]", vacancyName || "");
}

/** Все строки листа «ИИ анализ резюме» (для поиска ручных решений HR) */
export async function readAnalysisRows(spreadsheetId: string): Promise<Record<string, any>[]> {
    return readSheetObjects(spreadsheetId, SHEET_ANALYSIS);
}
