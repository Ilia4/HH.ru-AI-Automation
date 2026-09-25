/**
 * Работа с Google-таблицей вакансии (templatesUrl).
 * Листы: «ИИ анализ резюме», «Доп. фильтры», «Автоответы».
 * Перенос нод n8n «Записываем ИИ анализ», «Get row(s) in sheet», «Ищем ручные решения».
 */
import { sheets } from "../google/sheets.client";
import { cached, invalidatePrefix } from "../lib/sheet-cache";

/** Достаёт spreadsheetId из ссылки на Google-таблицу */
export function extractSpreadsheetId(url: string): string {
    const m = String(url || "").match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : "";
}

const SHEET_ANALYSIS = "ИИ анализ резюме";
const SHEET_FILTERS = "Доп. фильтры";
const SHEET_TEMPLATES = "Автоответы";

function columnToLetter(col0: number): string {
    let n = col0 + 1;
    let out = "";
    while (n > 0) {
        const r = (n - 1) % 26;
        out = String.fromCharCode(65 + r) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

async function readRawTable(spreadsheetId: string, sheetName: string): Promise<{ headers: string[]; rows: any[][] }> {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A1:BZ` });
    const values = resp.data.values || [];
    return {
        headers: (values[0] || []).map((v: any) => String(v || "").trim()),
        rows: values.slice(1),
    };
}

async function ensureHeaders(spreadsheetId: string, sheetName: string, required: string[]): Promise<string[]> {
    const table = await readRawTable(spreadsheetId, sheetName);
    const headers = [...table.headers];
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    const writes: { range: string; values: string[][] }[] = [];
    for (const title of required) {
        if (headers.some((h) => norm(h) === norm(title))) continue;
        const col = headers.length;
        headers.push(title);
        writes.push({ range: `${sheetName}!${columnToLetter(col)}1`, values: [[title]] });
    }
    if (writes.length) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: "RAW", data: writes },
        });
    }
    return headers;
}

function headerIndex(headers: string[], ...names: string[]): number {
    const wanted = new Set(names.map((x) => x.trim().toLowerCase()));
    return headers.findIndex((h) => wanted.has(String(h || "").trim().toLowerCase()));
}

/** Читает лист как массив объектов {заголовок: значение} */
async function readSheetObjects(spreadsheetId: string, sheetName: string, throwOnError = false): Promise<Record<string, any>[]> {
    try {
        const resp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:BZ`,
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
        if (throwOnError) throw err;
        return [];
    }
}

export interface AnalysisRow {
    resume_url: string;
    ai_comment: string;
    score: number | "";
    status: string;
    processed_date?: string; // дата обработки ботом, отформатированная
    fio?: string; // ФИО кандидата (для удобного поиска в таблице)
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

/** Гарантирует заголовок F «ФИО» */
async function ensureFioHeader(spreadsheetId: string): Promise<void> {
    try {
        const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET_ANALYSIS}!F1` });
        const cur = String(resp.data.values?.[0]?.[0] || "").trim();
        if (cur !== "ФИО") {
            await sheets.spreadsheets.values.update({
                spreadsheetId, range: `${SHEET_ANALYSIS}!F1`,
                valueInputOption: "USER_ENTERED", requestBody: { values: [["ФИО"]] },
            });
        }
    } catch { /* лист может отсутствовать — молча пропускаем */ }
}

/** Добавляет строку с результатом ИИ-анализа в лист «ИИ анализ резюме» */
export async function appendAnalysis(spreadsheetId: string, data: AnalysisRow): Promise<void> {
    await ensureProcessedHeader(spreadsheetId);
    await ensureFioHeader(spreadsheetId);
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${SHEET_ANALYSIS}!A:F`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [[data.resume_url, data.ai_comment, data.score, data.status, data.processed_date || "", data.fio || ""]],
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
        // ФИО берём новое, а если не передали — сохраняем старое из строки
        const fio = data.fio || String(existing["ФИО"] || "");
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${SHEET_ANALYSIS}!A${rowNum}:F${rowNum}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[data.resume_url, data.ai_comment, data.score, data.status, data.processed_date || "", fio]] },
        });
        return;
    }

    await appendAnalysis(spreadsheetId, data);
}

/**
 * Доп. фильтры заказчика + минимальный балл.
 * Берём ВСЕ непустые строки колонки «Фильтр» — HR добавляет критерии новыми
 * строками, и раньше учитывалась только первая, остальные молча терялись.
 */
export async function readFilters(spreadsheetId: string): Promise<{ filter: string; minScore: number }> {
    return cached(`filters:${spreadsheetId}`, async () => {
        const settings = await loadFilterSettings(spreadsheetId);
        return { filter: formatFiltersForAi(settings.filters), minScore: settings.minScore };
    });
}

export type FilterScoringMode = "auto" | "fixed";
export type FilterDirection = "plus" | "minus";
export interface VacancyFilter {
    row: number;
    text: string;
    mode: FilterScoringMode;
    direction: FilterDirection;
    /** Для fixed всегда число со знаком; для auto — null. */
    points: number | null;
}
export interface VacancyFilterSettings {
    minScore: number;
    filters: VacancyFilter[];
}

const FILTER_HEADERS = ["Фильтр", "Минимальный балл", "Режим веса", "Знак", "Баллы"];

/**
 * Мягкая миграция структуры настроек: только добавляет отсутствующие заголовки
 * справа, не двигает и не очищает существующие данные.
 */
export async function ensureVacancySettingsStructure(spreadsheetId: string): Promise<void> {
    await ensureHeaders(spreadsheetId, SHEET_FILTERS, FILTER_HEADERS);
    await ensureHeaders(spreadsheetId, SHEET_TEMPLATES, ["Условие, когда отправлять", "Тип", "Текст"]);
    resetFilterCache(spreadsheetId);
    invalidatePrefix(`templates:${spreadsheetId}`);
}

/** Полные настройки фильтров. Старые строки без веса читаются как Auto+. */
export async function readFilterSettings(spreadsheetId: string): Promise<VacancyFilterSettings> {
    return cached(`filter-settings:${spreadsheetId}`, () => loadFilterSettings(spreadsheetId));
}

async function loadFilterSettings(spreadsheetId: string): Promise<VacancyFilterSettings> {
    const table = await readRawTable(spreadsheetId, SHEET_FILTERS);
    const headers = table.headers;
    let iFilter = headerIndex(headers, "Фильтр");
    if (iFilter === -1) iFilter = headerIndex(headers, "Фильтры", "filter", "filters");
    let iMin = headerIndex(headers, "Минимальный балл");
    if (iMin === -1) iMin = headerIndex(headers, "Мин. балл", "min_score", "minScore");
    const iMode = headerIndex(headers, "Режим веса");
    const iDirection = headerIndex(headers, "Знак");
    const iPoints = headerIndex(headers, "Баллы");
    const filters: VacancyFilter[] = [];
    const seen = new Set<string>();
    let minScore = 7;
    for (let idx = 0; idx < table.rows.length; idx++) {
        const row = table.rows[idx] || [];
        const text = iFilter === -1 ? "" : String(row[iFilter] || "").trim();
        const key = text.toLowerCase();
        if (text && !seen.has(key)) {
            seen.add(key);
            const rawMode = iMode === -1 ? "" : String(row[iMode] || "").trim().toLowerCase();
            const rawDirection = iDirection === -1 ? "" : String(row[iDirection] || "").trim().toLowerCase();
            const rawPoints = iPoints === -1 ? "" : String(row[iPoints] ?? "").replace(",", ".").trim();
            const parsedPoints = Number(rawPoints);
            const mode: FilterScoringMode = rawMode.includes("фикс") || rawMode === "fixed" ? "fixed" : "auto";
            const direction: FilterDirection = rawDirection.includes("-") || rawDirection.includes("минус") ? "minus" : "plus";
            const abs = Number.isFinite(parsedPoints) ? Math.min(10, Math.abs(parsedPoints)) : 1;
            filters.push({
                row: idx + 2,
                text,
                mode,
                direction,
                points: mode === "fixed" ? (direction === "minus" ? -abs : abs) : null,
            });
        }
        const m = iMin === -1 ? "" : row[iMin];
        const num = Number(String(m ?? "").replace(",", "."));
        if (Number.isFinite(num) && m !== "" && m !== undefined) minScore = Math.max(0, Math.min(10, num));
    }
    return { filters, minScore };
}

/** Текст для промпта. Номера совпадают с filter_results, которые возвращает ИИ. */
export function formatFiltersForAi(filters: VacancyFilter[]): string {
    return filters.map((f, i) => {
        const weight = f.mode === "fixed"
            ? `FIXED ${f.points! > 0 ? "+" : ""}${f.points}`
            : `AUTO ${f.direction === "minus" ? "−" : "+"}`;
        return `${i + 1}. [${weight}] ${f.text}`;
    }).join("\n");
}

function resetFilterCache(spreadsheetId: string): void {
    invalidatePrefix(`filters:${spreadsheetId}`);
    invalidatePrefix(`filter-settings:${spreadsheetId}`);
}

export async function setMinimumScore(spreadsheetId: string, score: number): Promise<void> {
    if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("Проходной балл должен быть от 0 до 10");
    const headers = await ensureHeaders(spreadsheetId, SHEET_FILTERS, FILTER_HEADERS);
    const col = headerIndex(headers, "Минимальный балл");
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_FILTERS}!${columnToLetter(col)}2`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[Math.round(score * 10) / 10]] },
    });
    resetFilterCache(spreadsheetId);
}

export async function addFilter(
    spreadsheetId: string,
    input: Omit<VacancyFilter, "row">,
): Promise<VacancyFilter> {
    const current = await readFilterSettings(spreadsheetId);
    if (current.filters.length >= 50) throw new Error("Максимум 50 фильтров на вакансию");
    if (current.filters.some((f) => f.text.toLowerCase() === input.text.trim().toLowerCase())) throw new Error("Такой фильтр уже есть");
    const headers = await ensureHeaders(spreadsheetId, SHEET_FILTERS, FILTER_HEADERS);
    const table = await readRawTable(spreadsheetId, SHEET_FILTERS);
    const iFilter = headerIndex(headers, "Фильтр");
    const occupied = new Set(table.rows.map((r, idx) => String(r[iFilter] || "").trim() ? idx + 2 : 0).filter(Boolean));
    let row = 2;
    while (occupied.has(row)) row++;
    await writeFilterRow(spreadsheetId, headers, row, input);
    resetFilterCache(spreadsheetId);
    return { ...input, row };
}

export async function updateFilter(
    spreadsheetId: string,
    row: number,
    input: Omit<VacancyFilter, "row">,
): Promise<void> {
    if (!Number.isInteger(row) || row < 2) throw new Error("Неверная строка фильтра");
    const current = await readFilterSettings(spreadsheetId);
    if (!current.filters.some((f) => f.row === row)) throw new Error("Фильтр уже удалён или перемещён");
    if (current.filters.some((f) => f.row !== row && f.text.toLowerCase() === input.text.trim().toLowerCase())) throw new Error("Такой фильтр уже есть");
    const headers = await ensureHeaders(spreadsheetId, SHEET_FILTERS, FILTER_HEADERS);
    await writeFilterRow(spreadsheetId, headers, row, input);
    resetFilterCache(spreadsheetId);
}

async function writeFilterRow(
    spreadsheetId: string,
    headers: string[],
    row: number,
    input: Omit<VacancyFilter, "row">,
): Promise<void> {
    const direction = input.mode === "fixed"
        ? ((input.points ?? 0) < 0 ? "минус" : "плюс")
        : (input.direction === "minus" ? "минус" : "плюс");
    const values: Record<string, string | number> = {
        "Фильтр": input.text.trim(),
        "Режим веса": input.mode === "fixed" ? "фиксированный" : "авто",
        "Знак": direction,
        "Баллы": input.mode === "fixed" ? Math.abs(input.points ?? 1) : "",
    };
    const data = Object.entries(values).map(([title, value]) => {
        const col = headerIndex(headers, title);
        return { range: `${SHEET_FILTERS}!${columnToLetter(col)}${row}`, values: [[value]] };
    });
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data },
    });
}

export async function deleteFilter(spreadsheetId: string, row: number): Promise<void> {
    const current = await readFilterSettings(spreadsheetId);
    if (!current.filters.some((f) => f.row === row)) throw new Error("Фильтр уже удалён");
    const headers = await ensureHeaders(spreadsheetId, SHEET_FILTERS, FILTER_HEADERS);
    const data = ["Фильтр", "Режим веса", "Знак", "Баллы"].map((title) => ({
        range: `${SHEET_FILTERS}!${columnToLetter(headerIndex(headers, title))}${row}`,
        values: [[""]],
    }));
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "RAW", data },
    });
    resetFilterCache(spreadsheetId);
}

export interface AutoReplyTemplate {
    condition: string; // «Успешно» | «Отказ» | ...
    type: string; // «Резюме» | ...
    text: string;
}

/** Шаблоны автоответов из листа «Автоответы» */
export async function readTemplates(spreadsheetId: string): Promise<AutoReplyTemplate[]> {
    return cached(`templates:${spreadsheetId}`, () => loadTemplates(spreadsheetId));
}

export type TemplateKey = "resume_success" | "resume_reject" | "stage_success" | "stage_reject";
export interface EditableTemplate extends AutoReplyTemplate { key: TemplateKey; row: number | null }

const TEMPLATE_SPECS: Record<TemplateKey, { condition: string; type: string }> = {
    resume_success: { condition: "Успешно", type: "Резюме" },
    resume_reject: { condition: "Отказ", type: "Резюме" },
    stage_success: { condition: "Успешно", type: "Тестовое задание" },
    stage_reject: { condition: "Отказ", type: "Тестовое задание" },
};

export async function readEditableTemplates(spreadsheetId: string): Promise<EditableTemplate[]> {
    const table = await readRawTable(spreadsheetId, SHEET_TEMPLATES);
    const iCondition = headerIndex(table.headers, "Условие, когда отправлять");
    const iType = headerIndex(table.headers, "Тип");
    const iText = headerIndex(table.headers, "Текст");
    const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
    return (Object.keys(TEMPLATE_SPECS) as TemplateKey[]).map((key) => {
        const spec = TEMPLATE_SPECS[key];
        const idx = table.rows.findIndex((r) => norm(r[iCondition]) === norm(spec.condition) && norm(r[iType]) === norm(spec.type));
        return {
            key,
            ...spec,
            text: idx === -1 || iText === -1 ? "" : String(table.rows[idx][iText] || ""),
            row: idx === -1 ? null : idx + 2,
        };
    });
}

export async function setEditableTemplate(spreadsheetId: string, key: TemplateKey, text: string): Promise<void> {
    const spec = TEMPLATE_SPECS[key];
    if (!spec) throw new Error("Неизвестный шаблон");
    const value = String(text || "").trim();
    if (!value || value.length > 3000) throw new Error("Шаблон должен содержать от 1 до 3000 символов");
    const headers = await ensureHeaders(spreadsheetId, SHEET_TEMPLATES, ["Условие, когда отправлять", "Тип", "Текст"]);
    const existing = await readEditableTemplates(spreadsheetId);
    const found = existing.find((t) => t.key === key)!;
    const table = await readRawTable(spreadsheetId, SHEET_TEMPLATES);
    const row = found.row ?? (table.rows.length + 2);
    const values: Record<string, string> = {
        "Условие, когда отправлять": spec.condition,
        "Тип": spec.type,
        "Текст": value,
    };
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: "USER_ENTERED",
            data: Object.entries(values).map(([title, cell]) => ({
                range: `${SHEET_TEMPLATES}!${columnToLetter(headerIndex(headers, title))}${row}`,
                values: [[cell]],
            })),
        },
    });
    invalidatePrefix(`templates:${spreadsheetId}`);
}

async function loadTemplates(spreadsheetId: string): Promise<AutoReplyTemplate[]> {
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

/**
 * Заполняет приглашение после анализа резюме и гарантирует ссылки именно
 * текущей вакансии. Это защищает от общей Google-таблицы у нескольких вакансий.
 */
export function fillResumeSuccessTemplate(
    text: string,
    candidateName: string,
    vacancyName: string,
    vacancyId: string,
): string {
    let result = fillTemplate(text, candidateName, vacancyName);
    const id = String(vacancyId || "").trim();
    if (!id) return result;

    const vacancyUrl = `https://voronezh.hh.ru/vacancy/${id}`;
    result = result.replace(
        /https?:\/\/(?:[a-z0-9-]+\.)?hh\.ru\/vacancy\/\d+(?:\?[^\s]*)?/gi,
        vacancyUrl,
    );

    const formUrl = String(process.env[`HHRU_FORM_URL_${id}`] || "").trim();
    if (formUrl) {
        result = result.replace(/https:\/\/forms\.gle\/[a-zA-Z0-9_-]+/g, formUrl);
    }
    return result;
}

/** Все строки листа «ИИ анализ резюме» (для поиска ручных решений HR) */
export async function readAnalysisRows(spreadsheetId: string): Promise<Record<string, any>[]> {
    return readSheetObjects(spreadsheetId, SHEET_ANALYSIS);
}

/** Строгое чтение: ошибка Google не маскируется под пустой лист. */
export async function readAnalysisRowsStrict(spreadsheetId: string): Promise<Record<string, any>[]> {
    return readSheetObjects(spreadsheetId, SHEET_ANALYSIS, true);
}

/** Обновляет только текущий столбец «Статус» в конкретной строке анализа. */
export async function updateAnalysisStatus(
    spreadsheetId: string,
    rowNumber: number,
    status: string,
): Promise<void> {
    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
        throw new Error(`Некорректный номер строки анализа: ${rowNumber}`);
    }
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${SHEET_ANALYSIS}!D${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[status]] },
    });
}
