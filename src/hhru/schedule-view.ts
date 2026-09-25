/**
 * Расписание собеседований в удобном для показа виде.
 *
 * Источник один — тот же лист календаря, куда бот пишет брони
 * ({@link listInterviewBookings}). Здесь ничего не пишется, только читается.
 *
 * Пользуются два места:
 *   • команда /calendar в Telegram — расписание по вакансии темы;
 *   • раздел «Календарь» в панели — расписание по всем вакансиям.
 */
import { listInterviewBookings, normalizeDate, normalizeTime, InterviewBooking } from "./interview-calendar";
import { escapeTelegramHtml, resumeLinkHtml } from "./telegram-cards";

export interface ScheduleItem {
    date: string; // ДД.ММ.ГГГГ
    time: string; // ЧЧ:ММ
    /** ГГГГ-ММ-ДД — по нему сортируем и сравниваем с сегодняшним днём */
    sortKey: string;
    weekday: string;
    candidateFullName: string;
    vacancyName: string;
    resumeUrl?: string | null;
    contactCandidate?: string | null;
    past: boolean;
    today: boolean;
    weekend: boolean;
}

export interface ScheduleDay {
    date: string;
    sortKey: string;
    weekday: string;
    today: boolean;
    past: boolean;
    items: ScheduleItem[];
}

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** «Сегодня» считаем по Москве — по ней же живёт весь остальной бот. */
function todayKeyMsk(): string {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return msk.toISOString().slice(0, 10);
}

/** «13.08.2026» → «2026-08-13»; пустая строка, если дату не разобрать. */
function toSortKey(date: string): string {
    const [d, m, y] = normalizeDate(date).split(".");
    return d && m && y ? `${y}-${m}-${d}` : "";
}

function weekdayOf(sortKey: string): number {
    const [y, m, d] = sortKey.split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
}

/** «2026-08-13» → «13 августа, четверг» — так читается легче, чем голая дата. */
export function humanDate(sortKey: string): string {
    const [, m, d] = sortKey.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]}, ${WEEKDAYS[weekdayOf(sortKey)]}`;
}

function toItem(b: InterviewBooking, today: string): ScheduleItem | null {
    const sortKey = toSortKey(b.date);
    if (!sortKey) return null;
    const wd = weekdayOf(sortKey);
    return {
        date: normalizeDate(b.date),
        time: normalizeTime(b.time) || String(b.time || ""),
        sortKey,
        weekday: WEEKDAYS[wd],
        candidateFullName: b.candidateFullName,
        vacancyName: b.vacancyName,
        resumeUrl: b.resumeUrl ?? null,
        contactCandidate: b.contactCandidate ?? null,
        past: sortKey < today,
        today: sortKey === today,
        weekend: wd === 0 || wd === 6,
    };
}

/** Совпадение названий вакансии: без учёта регистра и лишних пробелов. */
export function sameVacancy(a: string, b: string): boolean {
    const norm = (x: string) => String(x || "").toLowerCase().replace(/\s+/g, " ").trim();
    const [x, y] = [norm(a), norm(b)];
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

/**
 * Всё расписание, отсортированное по дате и времени.
 * @param vacancyName если задано — только эта вакансия
 */
export async function getSchedule(vacancyName?: string): Promise<ScheduleItem[]> {
    const today = todayKeyMsk();
    const all = await listInterviewBookings();
    const items = all
        .map((b) => toItem(b, today))
        .filter((x): x is ScheduleItem => x !== null)
        .filter((x) => !vacancyName || sameVacancy(x.vacancyName, vacancyName));
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.time.localeCompare(b.time));
    return items;
}

/** То же расписание, но сгруппированное по дням — так его показывает панель. */
export function groupByDay(items: ScheduleItem[]): ScheduleDay[] {
    const days = new Map<string, ScheduleDay>();
    for (const it of items) {
        let day = days.get(it.sortKey);
        if (!day) {
            day = { date: it.date, sortKey: it.sortKey, weekday: it.weekday, today: it.today, past: it.past, items: [] };
            days.set(it.sortKey, day);
        }
        day.items.push(it);
    }
    return [...days.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

/**
 * Текст расписания для Telegram. Прошедшие встречи показываем свёрнуто —
 * в теме вакансии важнее то, что впереди.
 */
export function formatScheduleForTelegram(items: ScheduleItem[], title: string): string {
    if (!items.length) return `📅 <b>${escapeTelegramHtml(title)}</b>\n\nСобеседований пока не назначено.`;

    const upcoming = items.filter((x) => !x.past);
    const past = items.filter((x) => x.past);
    const lines: string[] = [`📅 <b>${escapeTelegramHtml(title)}</b>`];

    if (!upcoming.length) {
        lines.push("", "Впереди собеседований нет.");
    } else {
        let lastDay = "";
        for (const it of upcoming) {
            if (it.sortKey !== lastDay) {
                lines.push("", `<b>${it.today ? "🔸 сегодня, " : ""}${escapeTelegramHtml(humanDate(it.sortKey))}</b>`);
                lastDay = it.sortKey;
            }
            const flags = it.weekend ? " ⚠️ выходной" : "";
            lines.push(`   ${escapeTelegramHtml(it.time)} — ${escapeTelegramHtml(it.candidateFullName)}${flags}`);
            const resume = resumeLinkHtml(it.resumeUrl);
            if (resume) lines.push(`   ${resume}`);
        }
    }

    if (past.length) {
        lines.push("", `Прошедших встреч: ${past.length} (последняя ${past[past.length - 1].date}).`);
    }
    return lines.join("\n");
}
