import "dotenv/config";
import { Bot } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { CreateUserDTO } from "./types";
import * as userService from "./users/users.service";
import { sheets } from "./google/sheets.client";
import { syncActiveVacancies } from "./sheets_responsible/get_responsible";
import { syncInterviewNotifications } from "./interviews/interviews.service";
import { sendNewInterviewNotifications, send30MinReminders, sendNewVacancyNotifications } from "./notifications/notifications.service";
import { sendVacanciesToN8n, processAllQuestionnaires, type VacancyN8nResult } from "./hhru/hhru.service";
import { accumulateResult, getPeriodStats, resetPeriodStats, type VacancyPeriodStats } from "./hhru/period.store";
import { findThreadId, clearTopicsCache, saveTopic } from "./hhru/topics.store";
import { prisma } from "./lib/prisma.js";
import { createScheduler } from "./scheduler";
import { startOAuthServer } from "./hh-auth/web-server";
import { buildAuthorizeUrl, isAuthorized } from "./hh-auth/hh-auth.service";
import { registerInterviewTelegramReplyHandler } from "./hhru/interview-chat";
import { runChatRouter, registerHhQaReplyHandler } from "./hhru/chat-router";

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не найден");

const bot = process.env.SOCKS_PROXY
    ? new Bot(token, { client: { baseFetchConfig: { agent: new SocksProxyAgent(process.env.SOCKS_PROXY), compress: true } } })
    : new Bot(token);

bot.command("start", async (ctx) => {
    const user = ctx.from;

    if (!user) {
        await ctx.reply("Не удалось получить данные пользователя");
        return;
    }

    try {
        const username = user.username?.toLowerCase();
        const getUserInfo = username ? await getFullNameFromSheet(username) : null;

        const userData: CreateUserDTO = {
            tgUserId: String(user.id),
            firstName: user.first_name,
            lastName: user.last_name ?? null,
            username: username ?? null,
            fullNameFromGS: getUserInfo?.fullName ?? null,
            email: getUserInfo?.email ?? null,
        };

        const savedUser = await userService.addUserDb(userData);

        await ctx.reply(
            `Привет ${savedUser.fullNameFromGS ?? savedUser.firstName ?? savedUser.lastName ?? savedUser.username ?? savedUser.tgUserId}!\n` +
            `Запомнил тебя 👍 Если будет назначена новая встреча, пришлю уведомление ✅`
        );
    } catch (error) {
        console.error("Ошибка в /start:", error);
        await ctx.reply("Ошибка 🥺\nПопробуйте через пару минут");
    }
});

async function getFullNameFromSheet(username: string) {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_USERS;
    const range = process.env.GOOGLE_SHEETS_RANGE_USERS;

    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_USERS не указан в .env");
    if (!range) throw new Error("GOOGLE_SHEETS_RANGE_USERS не указан в .env");

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];

    const normalized = username.trim().replace("@", "").toLowerCase();

    const foundRow = rows.find((row) => {
        const tgUsername = String(row[3] || "").trim().replace("@", "").toLowerCase();
        return tgUsername === normalized;
    });

    if (!foundRow) return null;

    return {
        fullName: foundRow[1],
        email: foundRow[2],
        username: foundRow[3],
    };
}

bot.command("runnhh", async (ctx) => {
    const filter = ctx.match?.trim() || undefined;
    const label = filter ? `по фильтру "${filter}"` : "по всем вакансиям";
    const dry = process.env.HHRU_DRY_RUN !== "false";
    await ctx.reply(`Запускаю оценку резюме ${label}...${dry ? " (DRY-RUN, без действий на HH)" : ""}`);
    try {
        const results = await sendVacanciesToN8n(filter);
        if (results.length === 0) {
            await ctx.reply("Нет вакансий для обработки.");
            return;
        }

        const lines: string[] = [];
        for (const r of results) {
            if (r.success && r.data) {
                accumulateResult(r.vacancyName, r.data);
                const nr = r.data.new_responses;
                const mc = r.data.manual_check;
                lines.push(
                    `📊 ${r.vacancyName}\n` +
                    `   Новые: всего ${nr?.total ?? 0}, прошли ${nr?.passed_count ?? 0}, на проверку ${nr?.manual_count ?? 0}, отказ ${nr?.failed_count ?? 0}\n` +
                    `   Ручная проверка: обработано ${mc?.processed_total ?? 0} (принято ${mc?.accepted_count ?? 0}, отказ ${mc?.rejected_count ?? 0})`
                );
            } else {
                lines.push(`⚠️ ${r.vacancyName}: ошибка — ${r.error}`);
            }
        }

        await sendPeriodSummaryToGroup();
        await ctx.reply(`Готово ✅${dry ? " (DRY-RUN)" : ""} Сводка отправлена в группу.\n\n${lines.join("\n\n")}`);
    } catch (err: any) {
        if (err?.message === "HHRU_BUSY") {
            await ctx.reply("⏳ Обработка уже идёт. Дождись её завершения и попробуй снова.");
            return;
        }
        console.error(err);
        await ctx.reply("Ошибка ❌ Смотри логи.");
    }
});

function formatPeriodSummary(vacancyName: string, stats: VacancyPeriodStats, periodStart: string, periodEnd: string): string {
    const from = new Date(periodStart).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
    const to = new Date(periodEnd).toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

    let text = `📊 <b>${vacancyName}</b>\n`;
    text += `🕐 Период: ${from} — ${to}\n`;

    if (stats.new_total === 0 && stats.manual_processed === 0) {
        text += `📭 Новых откликов за период не было`;
        return text;
    }

    if (stats.new_total > 0) {
        text += `\n<b>Новые отклики:</b>\n`;
        text += `👥 Всего: ${stats.new_total}\n`;
        text += `✅ Прошли: ${stats.passed}\n`;
        text += `🤔 На проверку: ${stats.manual}\n`;
        text += `❌ Отказ: ${stats.failed}\n`;
    }

    if (stats.manual_processed > 0) {
        text += `\n<b>Ручная проверка:</b>\n`;
        text += `📋 Обработано: ${stats.manual_processed}\n`;
        text += `✅ Принято: ${stats.manual_accepted}\n`;
        text += `❌ Отклонено: ${stats.manual_rejected}\n`;
    }

    return text.trim();
}

async function sendPeriodSummaryToGroup() {
    const groupChatId = process.env.GROUP_CHAT_ID;
    console.log(`[group] GROUP_CHAT_ID=${groupChatId}`);
    if (!groupChatId) {
        console.warn("[hhru] GROUP_CHAT_ID не задан, пропускаем отправку в группу");
        return;
    }

    const stats = getPeriodStats();
    console.log(`[group] вакансий в статистике: ${Object.keys(stats).length}`);
    const periodEnd = new Date().toISOString();

    for (const [vacancyName, s] of Object.entries(stats)) {
        console.log(`[group] обрабатываю вакансию "${vacancyName}"`);
        try {
            const threadId = await findThreadId(bot, vacancyName);
            console.log(`[group] threadId для "${vacancyName}": ${threadId}`);
            const text = formatPeriodSummary(vacancyName, s, s.period_start, periodEnd);

            if (threadId) {
                console.log(`[group] отправляю в chat=${groupChatId} thread=${threadId}`);
                await bot.api.sendMessage(groupChatId, text, {
                    parse_mode: "HTML",
                    message_thread_id: threadId,
                });
                console.log(`[group] отправлено`);
            } else {
                console.warn(`[group] тема не найдена для "${vacancyName}", отправляю без темы`);
                await bot.api.sendMessage(groupChatId, text, { parse_mode: "HTML" });
                console.log(`[group] отправлено без темы`);
            }
        } catch (err) {
            console.error(`[group] ошибка отправки по "${vacancyName}":`, err);
        }
    }

    resetPeriodStats();
    clearTopicsCache();
}

// Прогон анкет (без действий на HH) — тихо, для часового цикла
async function runAnketaSilently() {
    try {
        const anketa = await processAllQuestionnaires();
        const total = anketa.reduce((s, a) => s + a.summary.evaluated, 0);
        console.log(`[anketa] авто-прогон: оценено новых анкет — ${total}`);
    } catch (err: any) {
        if (err?.message === "ANKETA_BUSY") {
            console.log("[anketa] авто-прогон пропущен — обработка уже идёт");
        } else {
            console.error("[anketa] ошибка авто-прогона:", err);
        }
    }
}

async function runHhruHourly() {
    console.log("[hhru] часовой запуск анализа");
    try {
        const results = await sendVacanciesToN8n();
        for (const r of results) {
            if (r.success && r.data) {
                accumulateResult(r.vacancyName, r.data);
            }
        }
        console.log(`[hhru] накоплено результатов: ${results.length}`);
    } catch (err) {
        console.error("[hhru] ошибка часового запуска:", err);
    }
    // после откликов — анкеты
    await runAnketaSilently();
}

async function runHhruWithReport() {
    console.log("[hhru] запуск с отправкой сводки в группу");
    try {
        const results = await sendVacanciesToN8n();
        for (const r of results) {
            if (r.success && r.data) {
                accumulateResult(r.vacancyName, r.data);
            }
        }
        await sendPeriodSummaryToGroup();
    } catch (err) {
        console.error("[hhru] ошибка запуска с отчётом:", err);
    }
    // после откликов — анкеты
    await runAnketaSilently();
}

async function notifyResponsibleUsers(results: VacancyN8nResult[]) {
    const adminChatId = process.env.ADMIN_CHAT_ID ?? null;

    for (const r of results) {
        try {
            const vacancy = await prisma.activeVacancy.findFirst({
                where: { vacancyName: r.vacancyName, isActive: true },
            });

            const recipients = new Set<string>();

            if (vacancy?.responsibleUserId) {
                const user = await prisma.user.findFirst({
                    where: { username: String(vacancy.responsibleUserId).replace("@", "").toLowerCase() },
                });
                if (user?.tgUserId) recipients.add(user.tgUserId);
            }

            if (adminChatId) recipients.add(adminChatId);

            console.log(`[hhru] результат по "${r.vacancyName}":`, JSON.stringify(r.data));
        } catch (err) {
            console.error(`[hhru] ошибка обработки результата "${r.vacancyName}":`, err);
        }
    }
}

async function runSync() {
    console.log(`[sync] запуск в ${new Date().toLocaleTimeString("ru-RU")}`);
    try {
        await syncActiveVacancies();
    } catch (err) {
        console.error("[sync] ошибка syncActiveVacancies:", err);
    }
    try {
        await sendNewVacancyNotifications(bot);
    } catch (err) {
        console.error("[sync] ошибка sendNewVacancyNotifications:", err);
    }
    try {
        await syncInterviewNotifications();
    } catch (err) {
        console.error("[sync] ошибка syncInterviewNotifications:", err);
    }
    try {
        await sendNewInterviewNotifications(bot);
    } catch (err) {
        console.error("[sync] ошибка sendNewInterviewNotifications:", err);
    }
    try {
        await send30MinReminders(bot);
    } catch (err) {
        console.error("[sync] ошибка send30MinReminders:", err);
    }
}

// Автоматически запоминаем темы группы по входящим сообщениям
bot.use((ctx, next) => {
    const msg = ctx.message;
    const groupChatId = process.env.GROUP_CHAT_ID;
    if (msg && groupChatId && String(msg.chat.id) === groupChatId) {
        const threadId = msg.message_thread_id;
        const topicName = (msg.reply_to_message as any)?.forum_topic_created?.name;
        if (threadId && topicName) {
            saveTopic(topicName, threadId);
        }
    }
    return next();
});

bot.command("auth", async (ctx) => {
    try {
        const url = buildAuthorizeUrl(String(ctx.chat.id));
        await ctx.reply(
            "Для авторизации в HH.ru открой ссылку и подтверди доступ:",
            {
                reply_markup: {
                    inline_keyboard: [[{ text: "🔑 Авторизоваться в HH.ru", url }]],
                },
            }
        );
    } catch (err: any) {
        await ctx.reply(`Ошибка: ${err.message}`);
    }
});

bot.command("authstatus", async (ctx) => {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (!adminChatId || String(ctx.chat.id) !== adminChatId) return;
    await ctx.reply(isAuthorized() ? "✅ Токен HH.ru сохранён" : "❌ Нет токена. Запусти /auth");
});

bot.command("runanket", async (ctx) => {
    const adminChatId = process.env.ADMIN_CHAT_ID;
    if (!adminChatId || String(ctx.chat.id) !== adminChatId) return;

    const filter = ctx.match?.trim() || undefined;
    const label = filter ? `по фильтру "${filter}"` : "по всем вакансиям";
    await ctx.reply(`Запускаю анализ анкет ${label}... (без действий на HH)`);

    try {
        const results = await processAllQuestionnaires(filter);
        if (results.length === 0) { await ctx.reply("Нет вакансий для обработки."); return; }

        const lines = results.map((r) => {
            const s = r.summary;
            return `📋 ${r.vacancyName}\n   оценено ${s.evaluated} (прошли ${s.passed}, нет ${s.failed}), без матча ${s.skipped_no_match}, уже было ${s.skipped_processed}`;
        });
        await ctx.reply(`Готово ✅ (анкеты, без действий на HH)\n\n${lines.join("\n\n")}`);
    } catch (err: any) {
        if (err?.message === "ANKETA_BUSY") {
            await ctx.reply("⏳ Обработка анкет уже идёт. Дождись завершения.");
            return;
        }
        console.error(err);
        await ctx.reply("Ошибка ❌ Смотри логи.");
    }
});

bot.command("regtopic", async (ctx) => {
    const threadId = ctx.message?.message_thread_id;
    const name = ctx.match?.trim();
    if (!threadId) { await ctx.reply("Команду нужно писать внутри темы"); return; }
    if (!name) { await ctx.reply("Укажи название: /regtopic Название вакансии"); return; }
    saveTopic(name, threadId);
    await ctx.reply(`Тема сохранена: "${name}" → thread_id=${threadId}`);
});

bot.command("chatid", async (ctx) => {
    const id = ctx.chat.id;
    const threadId = ctx.message?.message_thread_id ?? "нет";
    const title = ctx.chat.type !== "private" ? (ctx.chat as any).title : "личка";
    await ctx.reply(`chat_id: ${id}\nthread_id: ${threadId}\ntitle: ${title}`);
    console.log(`[chatid] id=${id} thread=${threadId} title=${title}`);
});

bot.catch((err) => {
    console.error("Ошибка в боте:", err);
});

registerHhQaReplyHandler(bot);
registerInterviewTelegramReplyHandler(bot);
startOAuthServer(bot);

bot.start();
console.log("Бот запущен");

// Каждые 5 минут: синхронизация вакансий, собеседований, уведомления
async function runChatRouterSync() {
    try {
        await runChatRouter(bot);
    } catch (err) {
        console.error("[chat-router] loop error:", err);
    }
}

runSync();
setInterval(runSync, 5 * 60 * 1000);

runChatRouterSync();
setInterval(runChatRouterSync, 60 * 1000);

// Планировщик по времени — тикает каждую минуту
const schedulerTick = createScheduler([
    // Каждый час в 00 минут (кроме 7 и 15) — тихий анализ, накапливаем статистику
    { name: "hhru-hourly", hours: [0,1,2,3,4,5,6,8,9,10,11,12,13,14,16,17,18,19,20,21,22,23], minutes: 0, run: runHhruHourly },
    // В 7:00 и 15:00 — анализ + сводка в группу
    { name: "hhru-report", hours: [7, 15], minutes: 0, run: runHhruWithReport },
]);
setInterval(schedulerTick, 60 * 1000);
