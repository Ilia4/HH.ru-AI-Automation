/**
 * Архивные вакансии на HH: по ним нельзя отправлять сообщения (HH → 403 invalid_vacancy)
 * и нельзя двигать стадию. Вместо бесполезных попыток (и мусора 403 в логах) собираем
 * таких кандидатов и одним сообщением на вакансию пишем в её тему в Telegram:
 * список ФИО-ссылок «напишите вручную».
 *
 * DRY (по умолчанию): уведомление не уходит в Telegram, а печатается в лог.
 * Боевой режим уведомлений — ARCHIVED_NOTIFY_DRY_RUN=false.
 */
import type { Bot } from "grammy";
import fs from "fs";
import path from "path";
import { findThreadId } from "./topics.store";
import { getVacancy } from "./hh-api";
import { isVacancyLiveByRegistry } from "./vacancy-mode";
import { safeHhResumeUrl } from "./telegram-cards";

const STORE_PATH = path.resolve(process.cwd(), "archived-notified.json");
const TTL_MS = 15 * 60 * 1000; // статус архивности кэшируем на 15 минут

/**
 * Точечный боевой режим для одной вакансии — даже когда глобальные флаги в DRY.
 *
 * Два источника, любой из них включает бой:
 *   • колонка «Режим» в реестре вакансий — основной способ, переключается из панели;
 *   • LIVE_VACANCY_IDS в .env — прежний список, оставлен для совместимости
 *     (им же удобно включить вакансию, которой ещё нет в реестре).
 *
 * Всё остальное остаётся в DRY: без явного «боевой» бот кандидатам не пишет.
 */
export function vacancyLiveOverride(vacancyId: string): boolean {
    if (isVacancyLiveByRegistry(vacancyId)) return true;
    const ids = (process.env.LIVE_VACANCY_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    return ids.length > 0 && ids.includes(String(vacancyId || ""));
}

const archivedCache = new Map<string, { archived: boolean; at: number }>();

/** Архивна ли вакансия на HH (с кэшем). Должна вызываться внутри контекста withHhAccount. */
export async function isVacancyArchived(vacancyId: string): Promise<boolean> {
    const id = String(vacancyId || "");
    if (!id) return false;
    const c = archivedCache.get(id);
    if (c && Date.now() - c.at < TTL_MS) return c.archived;
    try {
        const v: any = await getVacancy(id);
        const archived = !!v?.archived;
        archivedCache.set(id, { archived, at: Date.now() });
        return archived;
    } catch {
        // Не смогли определить — считаем НЕ архивной, пусть обычная логика попробует сама.
        return false;
    }
}

interface Entry { name: string; negotiationId: string; link: string; }
const queue = new Map<string, { vacancyName: string; entries: Entry[] }>();

function loadNotified(): Set<string> {
    try { return new Set<string>(JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"))); } catch { return new Set<string>(); }
}
let notified: Set<string> = loadNotified();
function saveNotified(): void {
    try { fs.writeFileSync(STORE_PATH, JSON.stringify([...notified]), "utf-8"); }
    catch (e: any) { console.error("[archived-notify] не сохранил стор:", e.message); }
}

/** Кандидат на архивной вакансии, которому нужно написать вручную. Дедуп: не повторяем уже уведомлённых. */
export function queueArchivedContact(vacancyId: string, vacancyName: string, e: Entry): void {
    const vid = String(vacancyId || "");
    if (!e.negotiationId) return;
    if (notified.has(`${vid}:${e.negotiationId}`)) return;      // уже уведомляли
    let g = queue.get(vid);
    if (!g) { g = { vacancyName, entries: [] }; queue.set(vid, g); }
    if (g.entries.some((x) => x.negotiationId === e.negotiationId)) return; // дубль в этом прогоне
    g.entries.push(e);
}

function esc(s: string): string {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Рассылает по одному сообщению на архивную вакансию со списком ФИО-ссылок.
 * dryRun=true — только печатает в лог, в Telegram не шлёт и не помечает уведомлёнными.
 */
const CHUNK = 25; // кандидатов на одно сообщение (лимит Telegram ~4096 символов)

export async function flushArchivedNotifications(bot: Bot, opts: { dryRun?: boolean } = {}): Promise<void> {
    const dryRun = opts.dryRun !== undefined ? opts.dryRun : (process.env.ARCHIVED_NOTIFY_DRY_RUN !== "false");
    const groupChatId = process.env.GROUP_CHAT_ID;
    for (const [vacancyId, g] of queue) {
        if (!g.entries.length) continue;
        const threadId = await findThreadId(bot, g.vacancyName);
        const total = g.entries.length;
        const parts = Math.ceil(total / CHUNK);
        let sentOk = true;

        for (let p = 0; p < parts; p++) {
            const slice = g.entries.slice(p * CHUNK, (p + 1) * CHUNK);
            const head = parts > 1
                ? `🗄 «${esc(g.vacancyName)}» в архиве на HH — напишите вручную (часть ${p + 1}/${parts}, всего ${total}):`
                : `🗄 Вакансия «${esc(g.vacancyName)}» в архиве на HH — бот не может писать этим кандидатам.\nНапишите вручную (ссылка «Резюме кандидата» открывает HH):`;
            const lines = slice.map((e, i) => {
                const link = safeHhResumeUrl(e.link);
                return `${p * CHUNK + i + 1}. ${esc(e.name)} — ${link
                    ? `<a href="${esc(link)}">Резюме кандидата</a>`
                    : "ссылка на резюме недоступна"}`;
            });
            const text = [head, "", ...lines].join("\n");

            if (dryRun || !groupChatId) {
                console.log(`[archived-notify:DRY] «${g.vacancyName}» часть ${p + 1}/${parts} (${slice.length} канд.) — НЕ отправлено (лог):\n${text}`);
                continue;
            }
            try {
                await bot.api.sendMessage(groupChatId, text, {
                    parse_mode: "HTML",
                    link_preview_options: { is_disabled: true },
                    ...(threadId ? { message_thread_id: threadId } : {}),
                } as any);
            } catch (e: any) {
                sentOk = false;
                console.error(`[archived-notify] не смог отправить уведомление по «${g.vacancyName}» (часть ${p + 1}/${parts}):`, e.message);
            }
        }

        if (!dryRun && groupChatId && sentOk) {
            for (const e of g.entries) notified.add(`${vacancyId}:${e.negotiationId}`);
            console.log(`[archived-notify] «${g.vacancyName}»: уведомление о ${total} кандидатах отправлено в Telegram (${parts} сообщ.)`);
        }
        g.entries = [];
    }
    if (!dryRun) saveNotified();
}
