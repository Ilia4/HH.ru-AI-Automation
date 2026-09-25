/**
 * Слой данных для веб-панели (раздел «Кандидаты»).
 * Только чтение. Переиспользует хелперы бота, ничего в HH/таблицы не пишет.
 */
import { listTrackedVacancies, extractSpreadsheetId } from "../chat-sim/vacancies";
import { sheets } from "../google/sheets.client";
import { withHhAccount } from "../hh-auth/account-context";
import {
    getAllNegotiationsByCollection,
    getNegotiationCollections,
    getConversationMessages,
    employerStage,
    HhNegotiation,
} from "../hhru/hh-api";

const RESUME_SHEET = "ИИ анализ резюме";
const ANKETA_SHEET = "ИИ анализ тестового задания";

export interface ResumeInfo {
    score: string;
    scoreNum: number | null;
    status: string;
    date: string;
    comment: string;
}
export interface AnketaInfo {
    filled: boolean;
    score: string;
    scoreNum: number | null;
    hrAction: string;
    date: string;
    conclusion: string;
    sent: string;
}
export interface Candidate {
    vacancyId: string;
    vacancyName: string;
    hhAccountEmail: string;
    fio: string;
    resumeUrl: string;
    resumeId: string;
    resume: ResumeInfo | null;
    anketa: AnketaInfo | null;
    // для правки статуса и ссылок «открыть строку»
    spreadsheetId: string;
    resumeGid: number | null;
    resumeRow: number | null;
    anketaGid: number | null;
    anketaRow: number | null;
}

/** Допустимые значения для записи (совпадают с тем, что понимает бот). */
export const RESUME_STATUS_OPTIONS = ["Ручная проверка", "Подходит", "Отказ"];
export const ANKETA_ACTION_OPTIONS = ["Ожидание", "Подходит", "Не подходит"];

// ---------- утилиты ----------

const lc = (s: any) => String(s ?? "").trim().toLowerCase();

function extractResumeId(url: string): string {
    const m = String(url || "").match(/\/resume\/([a-z0-9]+)/i);
    return m ? m[1].toLowerCase() : "";
}

function fioKey(fio: string): string {
    return String(fio || "")
        .toLowerCase()
        .replace(/ё/g, "е")
        .replace(/[^а-яa-z\s]/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .slice(0, 3)
        .join(" ");
}

function parseScore(raw: any): number | null {
    const s = String(raw ?? "").replace(",", ".").match(/-?\d+(\.\d+)?/);
    return s ? Number(s[0]) : null;
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

interface Table {
    headers: string[];
    rows: Record<string, any>[];
}

async function readTab(spreadsheetId: string, tab: string): Promise<Table | null> {
    try {
        const resp = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${tab}!A:BZ`,
        });
        const rows = resp.data.values || [];
        if (rows.length < 1) return { headers: [], rows: [] };
        const headers = (rows[0] || []).map((h: any) => String(h).trim());
        const out = rows.slice(1).map((row: any[], idx: number) => {
            const obj: Record<string, any> = { __row: idx + 2 };
            headers.forEach((h, i) => {
                obj[h] = row[i] ?? "";
            });
            obj.__cells = row;
            return obj;
        });
        return { headers, rows: out };
    } catch {
        return null;
    }
}

/** индекс первого заголовка, удовлетворяющего предикату */
function idxOf(headers: string[], pred: (h: string) => boolean): number {
    return headers.findIndex((h) => pred(lc(h)));
}

function cell(row: Record<string, any>, headers: string[], idx: number): string {
    if (idx < 0) return "";
    return String((row.__cells || [])[idx] ?? row[headers[idx]] ?? "").trim();
}

// ---------- парсинг листов ----------

interface ResumeEntry { fio: string; url: string; row: number; info: ResumeInfo }
interface AnketaEntry { fio: string; url: string; row: number; info: AnketaInfo }

/** индекс колонки «Статус» на листе резюме (для записи решения) */
function resumeStatusColIdx(headers: string[]): number {
    return idxOf(headers, (x) => x === "статус" || x.includes("статус"));
}
/** индекс колонки «Действие HR» на листе анкеты (для записи решения) */
function anketaActionColIdx(headers: string[]): number {
    return idxOf(headers, (x) => x.includes("действие hr"));
}

function parseResumeSheet(t: Table): Map<string, ResumeEntry> {
    const h = t.headers;
    const iUrl = idxOf(h, (x) => x.includes("резюме") && x.includes("ссыл"));
    const iComment = idxOf(h, (x) => x.includes("комментари"));
    const iScore = idxOf(h, (x) => x === "балл" || x.includes("балл"));
    const iStatus = resumeStatusColIdx(h);
    const iDate = idxOf(h, (x) => x.includes("дата"));
    const iFio = idxOf(h, (x) => x === "фио" || x.includes("фамили"));

    const map = new Map<string, ResumeEntry>();
    for (const row of t.rows) {
        const url = cell(row, h, iUrl);
        const fio = cell(row, h, iFio);
        if (!url && !fio) continue;
        const rid = extractResumeId(url);
        const key = rid || "fio:" + fioKey(fio);
        if (!key) continue;
        const score = cell(row, h, iScore);
        map.set(key, {
            fio,
            url,
            row: Number(row.__row) || 0,
            info: {
                score,
                scoreNum: parseScore(score),
                status: cell(row, h, iStatus),
                date: cell(row, h, iDate),
                comment: cell(row, h, iComment),
            },
        });
    }
    return map;
}

function parseAnketaSheet(t: Table): Map<string, AnketaEntry> {
    const h = t.headers;
    const iUrl = idxOf(h, (x) => x.includes("резюме") && x.includes("ссыл"));
    const iFio = idxOf(h, (x) => x === "фио" || x.includes("фамили"));
    const iScore = idxOf(h, (x) => x.includes("итоговый балл"));
    const iAction = anketaActionColIdx(h);
    const iDate = idxOf(h, (x) => x.includes("дата анализа") || x.includes("дата"));
    const iConcl = idxOf(h, (x) => x.includes("совокупное заключение") || x.includes("заключение"));
    const iSent = idxOf(h, (x) => x === "отправлено");

    const map = new Map<string, AnketaEntry>();
    for (const row of t.rows) {
        const url = cell(row, h, iUrl);
        const fio = cell(row, h, iFio);
        if (!url && !fio) continue;
        const rid = extractResumeId(url);
        const key = rid || "fio:" + fioKey(fio);
        if (!key) continue;
        const score = cell(row, h, iScore);
        map.set(key, {
            fio,
            url,
            row: Number(row.__row) || 0,
            info: {
                filled: true,
                score,
                scoreNum: parseScore(score),
                hrAction: cell(row, h, iAction),
                date: cell(row, h, iDate),
                conclusion: cell(row, h, iConcl),
                sent: cell(row, h, iSent),
            },
        });
    }
    return map;
}

/** карта названий листов → gid (sheetId) */
async function readSheetGids(spreadsheetId: string): Promise<Record<string, number>> {
    try {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: "sheets(properties(sheetId,title))",
        });
        const out: Record<string, number> = {};
        for (const s of meta.data.sheets || []) {
            const p = s.properties;
            if (p?.title != null && p.sheetId != null) out[p.title] = p.sheetId;
        }
        return out;
    } catch {
        return {};
    }
}

// ---------- сборка кандидатов ----------

let cache: { ts: number; data: Candidate[] } | null = null;
const TTL_MS = 3 * 60 * 1000;

export async function getAllCandidates(force = false): Promise<Candidate[]> {
    if (!force && cache && Date.now() - cache.ts < TTL_MS) return cache.data;

    const vacs = await listTrackedVacancies();
    const all: Candidate[] = [];

    for (const v of vacs) {
        const sid = extractSpreadsheetId(v.templatesUrl);
        if (!sid) continue;
        const [resumeTab, anketaTab, gids] = await Promise.all([
            readTab(sid, RESUME_SHEET),
            readTab(sid, ANKETA_SHEET),
            readSheetGids(sid),
        ]);
        const resumeMap: Map<string, ResumeEntry> = resumeTab ? parseResumeSheet(resumeTab) : new Map();
        const anketaMap: Map<string, AnketaEntry> = anketaTab ? parseAnketaSheet(anketaTab) : new Map();
        const resumeGid = gids[RESUME_SHEET] ?? null;
        const anketaGid = gids[ANKETA_SHEET] ?? null;

        const keys = new Set<string>([...resumeMap.keys(), ...anketaMap.keys()]);
        for (const key of keys) {
            const r = resumeMap.get(key);
            const a = anketaMap.get(key);
            const url = r?.url || a?.url || "";
            all.push({
                vacancyId: v.vacancyId,
                vacancyName: v.vacancyName,
                hhAccountEmail: v.hhAccountEmail,
                fio: (a?.fio || r?.fio || "").trim() || "(без ФИО)",
                resumeUrl: url,
                resumeId: extractResumeId(url) || (key.startsWith("fio:") ? "" : key),
                resume: r?.info || null,
                anketa: a?.info || null,
                spreadsheetId: sid,
                resumeGid,
                resumeRow: r?.row ?? null,
                anketaGid,
                anketaRow: a?.row ?? null,
            });
        }
    }

    all.sort((x, y) => x.vacancyName.localeCompare(y.vacancyName, "ru") || x.fio.localeCompare(y.fio, "ru"));
    cache = { ts: Date.now(), data: all };
    return all;
}

// ---------- карточка кандидата (живой чат из HH) ----------

/**
 * Запасной перечень стадий — если HH не отдал список коллекций вакансии.
 * Отказы идут последними: по ним ищем, только если в активных не нашли.
 */
const FALLBACK_COLLECTIONS = [
    "response",
    "consider",
    "phone_interview",
    "assessment",
    "interview",
    "offer",
    "hired",
    "discard_by_employer",
    "discard_by_applicant",
    "discard",
];

/**
 * Стадии, по которым имеет смысл искать отклик.
 * Берём реальный список у HH — так находятся и отказанные, и любые стадии,
 * которые HH добавит позже. Пустые коллекции пропускаем, чтобы не дёргать API зря.
 */
async function collectionsToScan(vacancyId: string): Promise<string[]> {
    const cols = await getNegotiationCollections(vacancyId).catch(() => []);
    const ids = cols.filter((c) => c.total > 0).map((c) => c.id).filter(Boolean);
    return ids.length ? ids : FALLBACK_COLLECTIONS;
}

export interface ChatMessage {
    from: "employer" | "applicant" | string;
    text: string;
    at: string;
}
export interface CandidateDetail {
    found: boolean;
    vacancyId: string;
    vacancyName: string;
    fio: string;
    resumeUrl: string;
    stage: string;
    negId: string;
    messages: ChatMessage[];
    note?: string;
}

export async function getCandidateDetail(vacancyId: string, resumeId: string): Promise<CandidateDetail> {
    const vacs = await listTrackedVacancies();
    const v = vacs.find((x) => x.vacancyId === vacancyId);
    const base: CandidateDetail = {
        found: false,
        vacancyId,
        vacancyName: v?.vacancyName || "",
        fio: "",
        resumeUrl: "",
        stage: "",
        negId: "",
        messages: [],
    };
    if (!v) return { ...base, note: "Вакансия не найдена в реестре" };
    const rid = String(resumeId || "").toLowerCase();

    return withHhAccount(v.hhAccountId, async () => {
        let match: HhNegotiation | null = null;
        for (const c of await collectionsToScan(vacancyId)) {
            const list: HhNegotiation[] = await getAllNegotiationsByCollection(c as any, vacancyId).catch(
                () => [] as HhNegotiation[],
            );
            match =
                list.find((n) => {
                    const byId = lc(n.resume?.id) === rid && rid !== "";
                    const byUrl = extractResumeId(n.resume?.alternate_url || n.resume?.url || "") === rid && rid !== "";
                    return byId || byUrl;
                }) || null;
            if (match) break;
        }
        if (!match)
            return {
                ...base,
                note: "Отклик на HH не найден: вакансия архивная, отклик удалён или резюме скрыто кандидатом. Оценка и решение выше взяты из таблицы и остаются в силе.",
            };

        const fio = [match.resume?.last_name, match.resume?.first_name, match.resume?.middle_name]
            .filter(Boolean)
            .join(" ");
        const messages: ChatMessage[] = [];
        if (match.messages_url) {
            const raw = await getConversationMessages(match.messages_url).catch(() => []);
            for (const m of raw) {
                messages.push({
                    from: m.author?.participant_type || "unknown",
                    text: String(m.text || ""),
                    at: String(m.created_at || ""),
                });
            }
        }
        return {
            found: true,
            vacancyId,
            vacancyName: v.vacancyName,
            fio,
            resumeUrl: match.resume?.alternate_url || "",
            stage: employerStage(match).name || "",
            negId: match.id,
            messages,
        };
    });
}

// ---------- запись решения HR (как ручная правка в таблице) ----------

export interface DecisionResult {
    ok: boolean;
    kind: "resume" | "anketa";
    value: string;
    cell?: string;
    error?: string;
}

/**
 * Пишет решение HR в нужную ячейку — ровно то, что HR делает руками в таблице.
 *  kind="resume" → лист «ИИ анализ резюме», колонка «Статус» (Ручная проверка/Подходит/Отказ)
 *  kind="anketa" → лист «ИИ анализ тестового задания», колонка «Действие HR» (Ожидание/Подходит/Не подходит)
 * Ряд ищем заново по resumeId (устойчиво к сдвигам). Значение валидируем.
 */
export interface DecisionRef {
    resumeId?: string;
    row?: number; // номер строки из списка (fallback, если нет resumeId)
    fio?: string; // для сверки, что пишем в верную строку
}

export async function applyDecision(
    vacancyId: string,
    kind: "resume" | "anketa",
    value: string,
    ref: DecisionRef,
): Promise<DecisionResult> {
    const options = kind === "resume" ? RESUME_STATUS_OPTIONS : ANKETA_ACTION_OPTIONS;
    if (!options.includes(value)) {
        return { ok: false, kind, value, error: `Недопустимое значение «${value}»` };
    }
    const vacs = await listTrackedVacancies();
    const v = vacs.find((x) => x.vacancyId === vacancyId);
    if (!v) return { ok: false, kind, value, error: "Вакансия не найдена" };
    const sid = extractSpreadsheetId(v.templatesUrl);
    if (!sid) return { ok: false, kind, value, error: "Нет таблицы вакансии" };

    const sheetName = kind === "resume" ? RESUME_SHEET : ANKETA_SHEET;
    const tab = await readTab(sid, sheetName);
    if (!tab || !tab.headers.length) {
        return { ok: false, kind, value, error: `Лист «${sheetName}» не найден` };
    }
    const iUrl = idxOf(tab.headers, (x) => x.includes("резюме") && x.includes("ссыл"));
    const iFio = idxOf(tab.headers, (x) => x === "фио" || x.includes("фамили"));
    const iDecision = kind === "resume" ? resumeStatusColIdx(tab.headers) : anketaActionColIdx(tab.headers);
    if (iDecision < 0) {
        return { ok: false, kind, value, error: `Колонка решения не найдена на «${sheetName}»` };
    }

    const rid = String(ref.resumeId || "").toLowerCase();
    let target: Record<string, any> | undefined;
    // 1) по resumeId (надёжнее всего)
    if (rid) {
        target = tab.rows.find((row) => extractResumeId(cell(row, tab.headers, iUrl)) === rid);
    }
    // 2) fallback по номеру строки + сверка ФИО (для строк без ссылки на резюме)
    if (!target && ref.row) {
        const cand = tab.rows.find((row) => Number(row.__row) === Number(ref.row));
        if (cand) {
            const rowFio = fioKey(cell(cand, tab.headers, iFio));
            const wantFio = fioKey(ref.fio || "");
            if (!wantFio || !rowFio || rowFio === wantFio) {
                target = cand;
            } else {
                return { ok: false, kind, value, error: `ФИО в строке ${ref.row} не совпадает — запись отменена` };
            }
        }
    }
    if (!target) {
        return { ok: false, kind, value, error: "Строка кандидата не найдена в таблице" };
    }
    const rowNumber = Number(target.__row);
    const colLetter = columnToLetter(iDecision);
    const range = `${sheetName}!${colLetter}${rowNumber}`;
    try {
        await sheets.spreadsheets.values.update({
            spreadsheetId: sid,
            range,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[value]] },
        });
    } catch (e: any) {
        return { ok: false, kind, value, error: String(e?.message || e) };
    }
    cache = null; // сбросить кэш списка, чтобы список обновился
    return { ok: true, kind, value, cell: range };
}
