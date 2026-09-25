/**
 * Раздел «Ошибки» — этап 1: читаем pm2-логи бота (только чтение), классифицируем.
 * Бота не трогаем. Позже добавим структурированную таблицу BotError в Postgres.
 */
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = process.env.PANEL_BOT_LOG_DIR || "/root/.pm2/logs";
const BOT_NAME = process.env.PANEL_BOT_NAME || "hr-tg-bot";
const TAIL_LINES = Number(process.env.PANEL_LOG_TAIL) || 6000;
const RECENT_WINDOW = 400; // последние N строк считаем «свежими»

export type Severity = "error" | "warn" | "info";
export interface ErrorGroup {
    type: string;
    title: string;
    severity: Severity;
    category: string;
    vacancy: string;
    count: number;
    sample: string;
    recent: boolean;
}
export interface ErrorsResult {
    groups: ErrorGroup[];
    scannedLines: number;
    totalErrorLines: number;
    ts: string;
}

// строки, которые НЕ ошибки (бизнес-действия/инфо)
const NOT_ERROR = /(✗ ОТКАЗ|предыдущий проход|пропускаю тик|✓|успешно отправлено)/i;
// признаки настоящего технического сбоя
const IS_ERROR =
    /(не смог|не удалось|ошибка [а-я]|Error:|Exception|Traceback|\b40[13]\b|\b429\b|\b5\d\d\b|invalid_|quota|rateLimit|ECONN|ETIMEDOUT|ENOTFOUND|Cannot read|TypeError|gateway_timeout|сбой)/i;

function readTail(file: string, n: number): string[] {
    try {
        const raw = fs.readFileSync(file, "utf-8");
        const lines = raw.split(/\r?\n/);
        return lines.length > n ? lines.slice(lines.length - n) : lines;
    } catch {
        return [];
    }
}

/** тег категории в начале строки: [anketa-hr], [chat-router], [sheets]… */
function categoryOf(line: string): string {
    const m = line.match(/\[([a-zA-Zа-яА-Я0-9_-]+)\]/);
    return m ? m[1] : "прочее";
}

/** название вакансии, если есть. Имена вакансий содержат пробел и кириллицу —
 *  это отсекает JSON-ключи ("errors","value","type") и названия листов ("Автоответы"). */
function vacancyOf(line: string): string {
    const cands: string[] = [];
    const g = line.match(/«([^«»]{6,90})»/); // бот пишет вакансии в «…»
    if (g) cands.push(g[1]);
    for (const m of line.matchAll(/"([^"]{10,90})"/g)) cands.push(m[1]);
    for (const c of cands) {
        const s = c.trim();
        if (/\s/.test(s) && /[а-яё]/i.test(s) && !/[:{}\[\]]/.test(s)) return s;
    }
    return "";
}

interface TypeDef {
    type: string;
    title: string;
    severity: Severity;
    test: RegExp;
}
const TYPES: TypeDef[] = [
    { type: "invalid_vacancy", title: "Архивная вакансия — HH отклоняет действие", severity: "warn", test: /invalid_vacancy/i },
    { type: "google_quota", title: "Превышена квота чтения Google Sheets", severity: "warn", test: /quota exceeded|rateLimit|quota metric/i },
    { type: "hh_timeout", title: "Таймаут/сбой HH API", severity: "warn", test: /gateway_timeout|\b50[0-4]\b|\b429\b|ECONN|ETIMEDOUT|ENOTFOUND/i },
    { type: "hh_403", title: "HH отклонил запрос (403)", severity: "warn", test: /\b403\b/i },
    { type: "config_anketa", title: "Не удалось извлечь ID таблицы анкеты", severity: "error", test: /не удалось извлечь id таблицы анкеты/i },
    { type: "code_error", title: "Сбой в коде (исключение)", severity: "error", test: /Traceback|TypeError|Cannot read|Exception/i },
];

function classify(line: string): TypeDef {
    for (const t of TYPES) if (t.test.test(line)) return t;
    return { type: "other", title: "Прочие ошибки", severity: "error", test: /.^/ };
}

export function getErrors(): ErrorsResult {
    const out = readTail(path.join(LOG_DIR, `${BOT_NAME}-out.log`), TAIL_LINES);
    const err = readTail(path.join(LOG_DIR, `${BOT_NAME}-error.log`), TAIL_LINES);
    // помечаем индекс для «свежести»: конкатенируем, помня границу
    const all = [...out, ...err];
    const total = all.length;

    const groups = new Map<string, ErrorGroup & { lastIdx: number }>();
    let totalErr = 0;

    all.forEach((line, idx) => {
        if (!line.trim()) return;
        if (NOT_ERROR.test(line)) return;
        if (!IS_ERROR.test(line)) return;
        totalErr++;
        const def = classify(line);
        const vac = vacancyOf(line);
        const cat = categoryOf(line);
        const key = `${def.type}|${vac}`;
        const isRecentIdx =
            (idx < out.length && idx >= out.length - RECENT_WINDOW) ||
            (idx >= out.length && idx >= total - RECENT_WINDOW);
        const g = groups.get(key);
        if (g) {
            g.count++;
            if (idx > g.lastIdx) {
                g.lastIdx = idx;
                g.sample = line.trim().slice(0, 300);
            }
            g.recent = g.recent || isRecentIdx;
        } else {
            groups.set(key, {
                type: def.type,
                title: def.title,
                severity: def.severity,
                category: cat,
                vacancy: vac,
                count: 1,
                sample: line.trim().slice(0, 300),
                recent: isRecentIdx,
                lastIdx: idx,
            });
        }
    });

    const list = [...groups.values()]
        .sort((a, b) => Number(b.recent) - Number(a.recent) || b.lastIdx - a.lastIdx || b.count - a.count)
        .map(({ lastIdx, ...rest }) => rest);

    return { groups: list, scannedLines: total, totalErrorLines: totalErr, ts: new Date().toISOString() };
}
