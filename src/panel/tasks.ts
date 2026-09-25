/**
 * Главный экран панели: «что делать сейчас».
 *
 * Раньше человек заходил и видел шесть разделов, не понимая, с чего начать.
 * Здесь собирается короткий список дел на сегодня — каждое с числом и адресом,
 * куда вести по клику.
 *
 * Только чтение. Данные берём из уже готовых источников, ничего нового не считаем.
 */
import { getAllCandidates } from "./data";
import { listPendingAnswers } from "../hhru/candidate-answers";
import { listTrackedVacancies, extractSpreadsheetId } from "../chat-sim/vacancies";
import { getSchedule, type ScheduleItem } from "../hhru/schedule-view";

export interface PendingAnswer {
    vacancyName: string;
    fio: string;
    text: string;
    date: string;
    resumeUrl: string;
    sheetUrl: string;
}

export interface TasksSummary {
    /** резюме со статусом «Ручная проверка» */
    resumeChecks: number;
    /** заполненные анкеты без решения HR */
    anketaDecisions: number;
    /** ответы кандидатов без статуса */
    answers: PendingAnswer[];
    /** собеседования сегодня и завтра */
    upcoming: ScheduleItem[];
    /** всего собеседований впереди */
    upcomingTotal: number;
}

/** ГГГГ-ММ-ДД по Москве — тем же способом, что и расписание. */
function dayKey(shiftDays = 0): string {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000 + shiftDays * 86400000);
    return msk.toISOString().slice(0, 10);
}

export async function getTasks(force = false): Promise<TasksSummary> {
    const candidates = await getAllCandidates(force).catch(() => []);

    const resumeChecks = candidates.filter(
        (c: any) => String(c.resume?.status || "").trim().toLowerCase() === "ручная проверка",
    ).length;

    // Анкета заполнена, а решение HR ещё не проставлено.
    const anketaDecisions = candidates.filter(
        (c: any) => c.anketa && !String(c.anketa.hrAction || "").trim(),
    ).length;

    // Ответы кандидатов — только по вакансиям, где есть такой лист.
    const answers: PendingAnswer[] = [];
    const vacancies = await listTrackedVacancies().catch(() => []);
    for (const v of vacancies) {
        const ss = extractSpreadsheetId(v.templatesUrl || "");
        if (!ss) continue;
        const rows = await listPendingAnswers(ss).catch(() => []);
        for (const r of rows) {
            answers.push({
                vacancyName: v.vacancyName,
                fio: r.fio,
                text: r.text,
                date: r.date,
                resumeUrl: r.resumeUrl,
                sheetUrl: `https://docs.google.com/spreadsheets/d/${ss}/edit`,
            });
        }
    }

    const schedule = await getSchedule().catch(() => [] as ScheduleItem[]);
    const future = schedule.filter((s) => !s.past);
    const tomorrow = dayKey(1);
    const upcoming = future.filter((s) => s.today || s.sortKey === tomorrow);

    return { resumeChecks, anketaDecisions, answers, upcoming, upcomingTotal: future.length };
}
