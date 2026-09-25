/**
 * Лист «Ответы кандидатов» — ручной отбор по ответу на автосообщение.
 *
 * Зачем: по части вакансий анкету не дают. После анализа резюме бот пишет
 * кандидату («чем вас заинтересовала вакансия?»), тот отвечает — и решение
 * принимает человек, прочитав ответ.
 *
 * Как устроено:
 *   1. Ответы кандидата бот складывает в лист (это делает chat-router).
 *      Несколько сообщений подряд склеиваются в одну строку — решение
 *      принимается по кандидату, а не по каждой реплике.
 *   2. HR ставит в колонке «Статус» → «Подходит» или «Отказ».
 *   3. Этот модуль исполняет решение теми же шаблонами, что и анкетная ветка:
 *      «Успешно + Тестовое задание» — приглашение на собеседование,
 *      «Отказ + Тестовое задание»   — отказ.
 *      После приглашения запускается согласование времени (interview-chat).
 *
 * Колонка «Отправлено» — след выполненного действия. Без неё бот повторял бы
 * отправку на каждом цикле, поэтому пишем её сразу после успешной отправки.
 */
import {
    getNegotiation,
    extractActions,
    employerStage,
    sendCandidateMessage,
    doNegotiationAction,
    getConversationMessages,
    type HhNegotiation,
} from "./hh-api";
import { sheets } from "../google/sheets.client";
import { extractSpreadsheetId, readTemplates, findTemplate, fillTemplate } from "./sheets-analysis";
import { categoryForDecision, shouldSkipSend } from "./message-dedup";
import { isVacancyArchived, vacancyLiveOverride } from "./archived-notify";
import { registerInterviewConversation } from "./interview-chat";
import { beginVacancyRun, canContinueVacancyRun } from "./vacancy-activity";

export const ANSWERS_SHEET = "Ответы кандидатов";

/** Заголовки листа. Первые пять создаёт HR, «Отправлено» дописываем сами. */
const HEAD = {
    date: "Дата ответа",
    text: "Текст",
    resumeUrl: "Ссылка на резюме",
    fio: "ФИО Кандидата",
    status: "Статус",
    sent: "Отправлено",
} as const;

export interface AnswerRow {
    rowNumber: number;
    date: string;
    text: string;
    resumeUrl: string;
    fio: string;
    status: string;
    sent: string;
}

export interface AnswersResult {
    checked: boolean;
    invited: number;
    rejected: number;
    skipped: number;
    message?: string;
}

function colLetter(i: number): string {
    let n = i + 1;
    let out = "";
    while (n > 0) {
        const r = (n - 1) % 26;
        out = String.fromCharCode(65 + r) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

function idxOf(headers: string[], title: string): number {
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    return headers.findIndex((h) => norm(h) === norm(title));
}

/** Ссылка вида https://hh.ru/resume/<resume_id>?t=<negotiation_id> */
function parseResumeLink(link: string): { resumeId: string; negotiationId: string } {
    const text = String(link || "");
    return {
        resumeId: text.match(/resume\/([^?#]+)/)?.[1] || "",
        negotiationId: text.match(/[?&]t=([^&#]+)/)?.[1] || "",
    };
}

/**
 * Есть ли в таблице вакансии лист ответов. Для вакансий с анкетой его нет —
 * там ничего не меняется, ветка просто не работает.
 */
export async function hasAnswersSheet(spreadsheetId: string): Promise<boolean> {
    if (!spreadsheetId) return false;
    try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title))" });
        return (meta.data.sheets || []).some((s) => String(s.properties?.title || "").trim() === ANSWERS_SHEET);
    } catch {
        return false;
    }
}

async function readSheet(spreadsheetId: string): Promise<{ headers: string[]; rows: AnswerRow[] } | null> {
    const resp = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${ANSWERS_SHEET}!A1:Z`,
    }).catch(() => null);
    if (!resp) return null;

    const values = resp.data.values || [];
    const headers = (values[0] || []).map((x: any) => String(x || "").trim());
    if (!headers.length) return null;

    const get = (row: any[], title: string) => {
        const i = idxOf(headers, title);
        return i === -1 ? "" : String(row[i] ?? "").trim();
    };

    const rows: AnswerRow[] = [];
    for (let i = 1; i < values.length; i++) {
        const row = values[i] || [];
        rows.push({
            rowNumber: i + 1,
            date: get(row, HEAD.date),
            text: get(row, HEAD.text),
            resumeUrl: get(row, HEAD.resumeUrl),
            fio: get(row, HEAD.fio),
            status: get(row, HEAD.status),
            sent: get(row, HEAD.sent),
        });
    }
    return { headers, rows };
}

/** Дописывает колонку «Отправлено», если её ещё нет. Остальные заголовки не трогаем. */
async function ensureSentColumn(spreadsheetId: string, headers: string[]): Promise<number> {
    const existing = idxOf(headers, HEAD.sent);
    if (existing !== -1) return existing;
    const col = headers.length;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${ANSWERS_SHEET}!${colLetter(col)}1`,
        valueInputOption: "RAW",
        requestBody: { values: [[HEAD.sent]] },
    });
    return col;
}

function nowStamp(): string {
    const msk = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(msk.getUTCDate())}.${p(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ${p(msk.getUTCHours())}:${p(msk.getUTCMinutes())}`;
}

/**
 * Записать ответ кандидата.
 * Если строка по этому резюме уже есть — дописываем текст к ней, а не плодим строки:
 * кандидат часто отвечает двумя-тремя сообщениями подряд, а решение по нему одно.
 * Строку с уже проставленным статусом не трогаем — решение HR важнее.
 */
export async function recordCandidateAnswer(
    spreadsheetId: string,
    answer: { text: string; resumeUrl: string; fio: string },
): Promise<{ written: boolean; reason?: string }> {
    const text = String(answer.text || "").trim();
    if (!spreadsheetId || !text) return { written: false, reason: "пустой текст" };

    const sheet = await readSheet(spreadsheetId);
    if (!sheet) return { written: false, reason: "нет листа ответов" };

    const { resumeId } = parseResumeLink(answer.resumeUrl);
    const existing = sheet.rows.find((r) => {
        const rid = parseResumeLink(r.resumeUrl).resumeId;
        return rid && resumeId && rid === resumeId;
    });

    // Уже есть строка: склеиваем ответы, если это новое сообщение.
    if (existing) {
        if (existing.status) return { written: false, reason: "по кандидату уже есть решение" };
        if (existing.text.includes(text)) return { written: false, reason: "такой ответ уже записан" };
        const textCol = idxOf(sheet.headers, HEAD.text);
        const dateCol = idxOf(sheet.headers, HEAD.date);
        const merged = `${existing.text}\n${text}`.trim();
        const data = [{ range: `${ANSWERS_SHEET}!${colLetter(textCol)}${existing.rowNumber}`, values: [[merged]] }];
        if (dateCol !== -1) {
            data.push({ range: `${ANSWERS_SHEET}!${colLetter(dateCol)}${existing.rowNumber}`, values: [[nowStamp()]] });
        }
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: "USER_ENTERED", data },
        });
        return { written: true };
    }

    // Новой строкой — в порядке заголовков листа, чтобы не зависеть от их перестановки.
    const row: string[] = new Array(sheet.headers.length).fill("");
    const put = (title: string, value: string) => {
        const i = idxOf(sheet.headers, title);
        if (i !== -1) row[i] = value;
    };
    put(HEAD.date, nowStamp());
    put(HEAD.text, text);
    put(HEAD.resumeUrl, answer.resumeUrl);
    put(HEAD.fio, answer.fio);

    // Пишем по точному адресу: append при пустой колонке A умеет сдвигать данные.
    const nextRow = sheet.rows.length + 2;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${ANSWERS_SHEET}!A${nextRow}:${colLetter(Math.max(sheet.headers.length - 1, 0))}${nextRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
    });
    return { written: true };
}

/** Ответы, по которым HR ещё не принял решение — для панели. */
export async function listPendingAnswers(spreadsheetId: string): Promise<AnswerRow[]> {
    const sheet = await readSheet(spreadsheetId);
    if (!sheet) return [];
    return sheet.rows.filter((r) => r.text && !r.status);
}

/** Безопасная запись решения из Telegram/панели в лист ответов. */
export async function applyCandidateAnswerDecision(
    spreadsheetId: string,
    value: "Подходит" | "Отказ",
    ref: { row?: number; resumeId?: string; fio?: string },
): Promise<{ ok: boolean; cell?: string; error?: string }> {
    if (!spreadsheetId) return { ok: false, error: "Нет таблицы вакансии" };
    const sheet = await readSheet(spreadsheetId);
    if (!sheet) return { ok: false, error: "Лист «Ответы кандидатов» не найден" };
    const statusCol = idxOf(sheet.headers, HEAD.status);
    if (statusCol === -1) return { ok: false, error: "Колонка «Статус» не найдена" };

    const wantedResumeId = String(ref.resumeId || "").trim().toLowerCase();
    const normFio = (x: string) => String(x || "").toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z\s]/gi, " ").replace(/\s+/g, " ").trim();
    let target = wantedResumeId
        ? sheet.rows.find((row) => parseResumeLink(row.resumeUrl).resumeId.toLowerCase() === wantedResumeId)
        : undefined;
    if (!target && ref.row) {
        const candidate = sheet.rows.find((row) => row.rowNumber === Number(ref.row));
        if (candidate && ref.fio && normFio(candidate.fio) !== normFio(ref.fio)) {
            return { ok: false, error: `ФИО в строке ${ref.row} изменилось — запись отменена` };
        }
        target = candidate;
    }
    if (!target) return { ok: false, error: "Строка кандидата не найдена" };
    if (target.sent) return { ok: false, error: "По кандидату действие уже выполнено" };
    if (target.status && target.status !== value) return { ok: false, error: `В таблице уже стоит решение «${target.status}»` };

    const cell = `${ANSWERS_SHEET}!${colLetter(statusCol)}${target.rowNumber}`;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: cell,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[value]] },
    });
    return { ok: true, cell };
}

export interface AnswersInput {
    vacancyId: string;
    vacancyName: string;
    templatesUrl?: string | null;
}

/**
 * Исполнить решения HR из листа ответов.
 * Работает только по строкам со статусом и без отметки «Отправлено».
 */
export async function processCandidateAnswers(
    vacancy: AnswersInput,
    options: { dryRun?: boolean } = {},
): Promise<AnswersResult> {
    const dryRun = vacancyLiveOverride(vacancy.vacancyId) ? false : options.dryRun !== false;
    const tag = dryRun ? "[answers:DRY]" : "[answers:LIVE]";
    const runToken = beginVacancyRun(vacancy.vacancyId);
    if (!canContinueVacancyRun(runToken)) {
        return { checked: false, invited: 0, rejected: 0, skipped: 0, message: "вакансия приостановлена" };
    }

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return { checked: false, invited: 0, rejected: 0, skipped: 0, message: "нет таблицы вакансии" };

    const sheet = await readSheet(spreadsheetId);
    if (!sheet) return { checked: false, invited: 0, rejected: 0, skipped: 0, message: "нет листа «Ответы кандидатов»" };
    if (!canContinueVacancyRun(runToken)) {
        return { checked: false, invited: 0, rejected: 0, skipped: 0, message: "вакансия приостановлена" };
    }

    const pending = sheet.rows.filter((r) => {
        const status = r.status.toLowerCase();
        return (status === "подходит" || status === "отказ") && !r.sent;
    });
    if (!pending.length) return { checked: true, invited: 0, rejected: 0, skipped: 0 };

    if (await isVacancyArchived(vacancy.vacancyId)) {
        console.log(`${tag} «${vacancy.vacancyName}» в архиве — решения не исполняем`);
        return { checked: true, invited: 0, rejected: 0, skipped: pending.length, message: "вакансия в архиве" };
    }
    if (!canContinueVacancyRun(runToken)) {
        return { checked: false, invited: 0, rejected: 0, skipped: 0, message: "вакансия приостановлена" };
    }

    const templates = await readTemplates(spreadsheetId);
    const sentCol = dryRun ? -1 : await ensureSentColumn(spreadsheetId, sheet.headers);

    let invited = 0, rejected = 0, skipped = 0;

    for (const row of pending) {
        if (!canContinueVacancyRun(runToken)) {
            console.log(`${tag} «${vacancy.vacancyName}» приостановлена — оставшиеся решения не исполняются`);
            break;
        }
        const isInvite = row.status.toLowerCase() === "подходит";
        const { negotiationId } = parseResumeLink(row.resumeUrl);
        const who = row.fio || row.resumeUrl || `строка ${row.rowNumber}`;

        if (!negotiationId) {
            console.warn(`${tag} • ${who}: в ссылке нет отклика (?t=…) — пропуск`);
            skipped++;
            continue;
        }

        let hh: HhNegotiation | null = null;
        try {
            hh = await getNegotiation(negotiationId);
        } catch (e: any) {
            console.warn(`${tag} • ${who}: не смог получить отклик — ${e.message}`);
            skipped++;
            continue;
        }
        if (!hh) { skipped++; continue; }
        if (!canContinueVacancyRun(runToken)) break;

        const stage = employerStage(hh);
        const stageId = String(stage.id || "");
        const name = row.fio || [hh.resume?.last_name, hh.resume?.first_name].filter(Boolean).join(" ");

        // Защита от повторов: смотрим, что уже писали кандидату.
        const category = categoryForDecision(row.status, "anketa");
        if (category && hh.messages_url) {
            const messages = await getConversationMessages(hh.messages_url).catch(() => []);
            const verdict = shouldSkipSend(messages as any, category);
            if (!canContinueVacancyRun(runToken)) break;
            if (verdict.skip) {
                console.log(`${tag} • ${name}: пропуск — ${verdict.reason}`);
                if (!dryRun && sentCol !== -1) await markSent(spreadsheetId, row.rowNumber, sentCol, `пропущено: ${verdict.reason}`);
                skipped++;
                continue;
            }
        }

        const condition = isInvite ? "Успешно" : "Отказ";
        const tpl = findTemplate(templates, condition, "Тестовое задание");
        const message = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
        if (!tpl) console.warn(`${tag} ⚠ ${name}: нет шаблона «${condition} + Тестовое задание»`);

        if (dryRun) {
            console.log(`${tag} • ${name}: ${isInvite ? "ПРИГЛАСИЛ БЫ на собеседование" : "ОТКАЗ"} (стадия «${stage.name || stageId}»)`);
            isInvite ? invited++ : rejected++;
            continue;
        }

        try {
            if (!canContinueVacancyRun(runToken)) break;
            const actions = extractActions(hh);
            if (isInvite) {
                if (message && hh.messages_url) await sendCandidateMessage(hh.messages_url, message);
                // Стадия должна отражать реальность: приглашённый не остаётся в «Подумать».
                if (actions.action_interview_url && !["interview", "offer", "hired"].includes(stageId)) {
                    await doNegotiationAction(actions.action_interview_url, actions.action_interview_method)
                        .catch((e: any) => console.warn(`${tag} ⚠ ${name}: стадию не сдвинул — ${e.message}`));
                }
                // Дальше время согласует бот — тот же тракт, что работал после анкет.
                await registerInterviewConversation(vacancy, hh);
                await markSent(spreadsheetId, row.rowNumber, sentCol, `приглашение ${nowStamp()}`);
                console.log(`${tag} ✓ ${name}: приглашение на собеседование отправлено`);
                invited++;
            } else {
                if (stageId.startsWith("discard")) {
                    if (message && hh.messages_url) await sendCandidateMessage(hh.messages_url, message);
                } else if (actions.action_discard_url) {
                    await doNegotiationAction(actions.action_discard_url, actions.action_discard_method, message || undefined);
                } else {
                    console.warn(`${tag} ⚠ ${name}: нет действия «отказ» на HH`);
                }
                await markSent(spreadsheetId, row.rowNumber, sentCol, `отказ ${nowStamp()}`);
                console.log(`${tag} ✓ ${name}: отказ отправлен`);
                rejected++;
            }
        } catch (e: any) {
            console.error(`${tag} ✗ ${name}: ${e.message}`);
            skipped++;
        }
    }

    return { checked: true, invited, rejected, skipped };
}

async function markSent(spreadsheetId: string, rowNumber: number, col: number, text: string): Promise<void> {
    if (col === -1) return;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${ANSWERS_SHEET}!${colLetter(col)}${rowNumber}`,
        valueInputOption: "RAW",
        requestBody: { values: [[text]] },
    });
}
