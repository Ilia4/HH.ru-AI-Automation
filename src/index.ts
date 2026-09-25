import "dotenv/config";
import { Bot } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { CreateUserDTO } from "./types";
import * as userService from "./users/users.service";
import { sheets } from "./google/sheets.client";
import { syncActiveVacancies } from "./sheets_responsible/get_responsible";
import { syncInterviewNotifications } from "./interviews/interviews.service";
import { sendNewInterviewNotifications, send30MinReminders, sendNewVacancyNotifications } from "./notifications/notifications.service";
import { sendVacanciesToN8n, processAllQuestionnaires, processAllCandidateAnswers, type VacancyN8nResult } from "./hhru/hhru.service";
import { accumulateResult, getPeriodStats, resetPeriodStats, type VacancyPeriodStats } from "./hhru/period.store";
import { findThreadId, clearTopicsCache, saveTopic, vacancyByThread } from "./hhru/topics.store";
import { getSchedule, formatScheduleForTelegram } from "./hhru/schedule-view";
import { prisma } from "./lib/prisma.js";
import { createScheduler } from "./scheduler";
import { refreshStageCounts, snapshotStageHistory } from "./analytics/stage-sync";
import { registerAnalyticsAssistant } from "./analytics/assistant";
import { runTokenMonitor } from "./analytics/token-monitor";
import { startOAuthServer } from "./hh-auth/web-server";
import { isAuthorized } from "./hh-auth/hh-auth.service";
import { privateMainKeyboard, registerHhAccountsMenu } from "./hh-auth/telegram-menu";
import { registerInterviewTelegramReplyHandler } from "./hhru/interview-chat";
import { runChatRouter, registerHhQaReplyHandler } from "./hhru/chat-router";
import { flushArchivedNotifications } from "./hhru/archived-notify";
import { registerConfirmHandlers, runInterviewConfirmSweep } from "./hhru/interview-confirm";
import { adminTelegramIds, isAdminTelegramId } from "./auth/admin";
import { startCacheStatsLog } from "./lib/sheet-cache";
import { registerVacancySettingsMenu } from "./hhru/settings-menu";
import { listTrackedVacancies } from "./chat-sim/vacancies";

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

        const showAccountMenu = ctx.chat.type === "private" && isAdminTelegramId(user.id);
        await ctx.reply(
            `Привет ${savedUser.fullNameFromGS ?? savedUser.firstName ?? savedUser.lastName ?? savedUser.username ?? savedUser.tgUserId}!\n` +
            `Запомнил тебя 👍 Если будет назначена новая встреча, пришлю уведомление ✅`,
            showAccountMenu ? { reply_markup: privateMainKeyboard() } : undefined,
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
                accumulateResult(r.vacancyName, r.data, r.hhAccountEmail);
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
    if (stats.hh_account_email) {
        text += `👤 <b>Аккаунт HH:</b> ${stats.hh_account_email}\n`;
    }
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

    // period-stats.json хранит историю между часовыми запусками. Раньше после
    // паузы ключи оставались там навсегда, и Telegram присылал нулевые карточки
    // по всем остановленным вакансиям. Источник истины для отчёта — активный реестр.
    const activeVacancies = await listTrackedVacancies();
    const activeNames = new Set(activeVacancies.map((vacancy) => vacancy.vacancyName));
    const stats = Object.fromEntries(
        Object.entries(getPeriodStats()).filter(([vacancyName]) => activeNames.has(vacancyName)),
    );
    console.log(`[group] активных вакансий в статистике: ${Object.keys(stats).length}`);
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

    resetPeriodStats(activeNames);
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
                accumulateResult(r.vacancyName, r.data, r.hhAccountEmail);
            }
        }
        console.log(`[hhru] накоплено результатов: ${results.length}`);
    } catch (err) {
        console.error("[hhru] ошибка часового запуска:", err);
    }
    // после откликов — анкеты
    await runAnketaSilently();
    // архивные вакансии: одно уведомление на вакансию «написать вручную»
    await flushArchivedNotifications(bot);
}

async function runHhruWithReport() {
    console.log("[hhru] запуск с отправкой сводки в группу");
    try {
        const results = await sendVacanciesToN8n();
        for (const r of results) {
            if (r.success && r.data) {
                accumulateResult(r.vacancyName, r.data, r.hhAccountEmail);
            }
        }
        await sendPeriodSummaryToGroup();
    } catch (err) {
        console.error("[hhru] ошибка запуска с отчётом:", err);
    }
    // после откликов — анкеты
    await runAnketaSilently();
    // архивные вакансии: одно уведомление на вакансию «написать вручную»
    await flushArchivedNotifications(bot);
}

async function notifyResponsibleUsers(results: VacancyN8nResult[]) {
    const adminChatIds = adminTelegramIds();

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

            for (const adminChatId of adminChatIds) recipients.add(adminChatId);

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
        // Диагностика: видно, дошёл ли reply от человека и на какое сообщение он ссылается.
        // Без этого молчаливый промах по message_id невозможно отличить от «бот не получил».
        if (msg.reply_to_message && msg.text) {
            const from = msg.from?.username ? "@" + msg.from.username : (msg.from?.first_name || "?");
            console.log(
                `[tg-in] reply от ${from} | тема ${threadId ?? "-"} | ` +
                `на сообщение ${msg.reply_to_message.message_id} | ` +
                `свой id ${msg.message_id} | текст: ${String(msg.text).slice(0, 60)}`
            );
        }
    }
    return next();
});

bot.command("authstatus", async (ctx) => {
    if (!isAdminTelegramId(ctx.from?.id)) {
        if (ctx.chat?.type === "private") {
            await ctx.reply("Эта команда доступна только администраторам бота. Если доступ нужен — попросите добавить вас.");
        }
        return;
    }
    await ctx.reply(await isAuthorized()
        ? "✅ Подключён хотя бы один аккаунт HH.ru"
        : "❌ Нет аккаунтов HH.ru. Открой «Аккаунты HH.ru»");
});

bot.command("runanket", async (ctx) => {
    if (!isAdminTelegramId(ctx.from?.id)) {
        if (ctx.chat?.type === "private") {
            await ctx.reply("Эта команда доступна только администраторам бота. Если доступ нужен — попросите добавить вас.");
        }
        return;
    }

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

/**
 * /calendar — расписание собеседований.
 * В теме вакансии показываем её собственное расписание, в общем чате — всё сразу.
 * Пишем «calendare» тоже: так команду назвали при постановке задачи.
 */
bot.command(["calendar", "calendare", "sobes"], async (ctx) => {
    // В личке календарь с ФИО кандидатов показываем только администраторам.
    if (ctx.chat?.type === "private" && !isAdminTelegramId(ctx.from?.id)) {
        await ctx.reply("Расписание собеседований доступно в рабочей группе — напишите /calendar в теме нужной вакансии.");
        return;
    }

    const reply = {
        reply_parameters: { message_id: ctx.message!.message_id },
        parse_mode: "HTML" as const,
        link_preview_options: { is_disabled: true },
    } as const;
    const wantsAll = /^(все|всё|all)$/i.test(ctx.match?.trim() || "");
    const vac = wantsAll ? null : await vacancyByThread(ctx.message?.message_thread_id);

    try {
        if (vac) {
            const items = await getSchedule(vac.vacancyName);
            await ctx.reply(formatScheduleForTelegram(items, vac.vacancyName), reply);
            return;
        }

        const items = await getSchedule();
        if (!items.length) {
            await ctx.reply("📅 Собеседований пока не назначено ни по одной вакансии.", reply);
            return;
        }

        // Вне темы вакансии показываем всё, разбив по вакансиям.
        const byVacancy = new Map<string, typeof items>();
        for (const it of items) {
            const list = byVacancy.get(it.vacancyName) || [];
            list.push(it);
            byVacancy.set(it.vacancyName, list);
        }
        const blocks = [...byVacancy.entries()].map(([name, list]) => formatScheduleForTelegram(list, name));
        const hint = wantsAll
            ? ""
            : "\n\nЧтобы увидеть расписание одной вакансии, напишите /calendar в её теме.";
        await ctx.reply(blocks.join("\n\n———\n\n") + hint, reply);
    } catch (err: any) {
        console.error("[calendar]", err?.message || err);
        await ctx.reply("Не смог прочитать календарь собеседований 😔 Попробуйте через пару минут.", reply);
    }
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

registerVacancySettingsMenu(bot);
registerAnalyticsAssistant(bot);
registerHhQaReplyHandler(bot);
registerConfirmHandlers(bot);
registerInterviewTelegramReplyHandler(bot);
registerHhAccountsMenu(bot);
startOAuthServer(bot);

bot.api.setMyCommands([
    { command: "start", description: "Открыть главное меню" },
    { command: "accounts", description: "Аккаунты HH.ru" },
    { command: "auth", description: "Добавить аккаунт HH.ru" },
    { command: "authstatus", description: "Проверить наличие аккаунтов" },
    { command: "calendar", description: "Собеседования: расписание по вакансии темы" },
    { command: "settings", description: "Настройки вакансии и кандидаты" },
]).catch((error) => console.error("[bot-menu] не удалось обновить команды:", error));

startCacheStatsLog();
bot.start();
console.log("Бот запущен");

/**
 * Защита от наложения периодических задач.
 * setInterval запускает следующий проход независимо от того, закончился ли предыдущий.
 * При медленных ответах HH (502/504) проход длится дольше интервала, и два прохода идут
 * параллельно: оба читают курсор переписки ДО того, как первый его обновит, — кандидатское
 * сообщение уходило в Telegram дважды. Пока предыдущий проход не закончился, новый пропускаем.
 */
function once(name: string, fn: () => Promise<void>): () => Promise<void> {
    let running = false;
    return async () => {
        if (running) {
            console.warn(`[${name}] предыдущий проход ещё идёт — пропускаю тик`);
            return;
        }
        running = true;
        try {
            await fn();
        } finally {
            running = false;
        }
    };
}

// Каждые 5 минут: синхронизация вакансий, собеседований, уведомления
const runChatRouterSync = once("chat-router", async () => {
    try {
        await runChatRouter(bot);
    } catch (err) {
        console.error("[chat-router] loop error:", err);
    }
    try {
        await runInterviewConfirmSweep(bot);
    } catch (err) {
        console.error("[confirm] sweep error:", err);
    }
});

runSync();
setInterval(runSync, 5 * 60 * 1000);

runChatRouterSync();
setInterval(runChatRouterSync, 60 * 1000);

// Решения HR из листа «Ответы кандидатов»: приглашение на собеседование или отказ.
// Проверяем раз в 5 минут — статус проставляется руками, ждать дольше незачем.
const runAnswerDecisions = once("answers", async () => {
    try {
        await processAllCandidateAnswers();
    } catch (err) {
        console.error("[answers] loop error:", err);
    }
});
runAnswerDecisions();
setInterval(runAnswerDecisions, 5 * 60 * 1000);

// Аналитика по стадиям HH → локальная база (счётчики обновляем каждые 5 минут)
const runStageSync = once("stage-sync", async () => {
    try { await refreshStageCounts(); } catch (err) { console.error("[stage-sync] loop error:", err); }
});
runStageSync();
setInterval(runStageSync, 5 * 60 * 1000);

// Монитор токена HH — раз в минуту; алерт в General при отвале токена (не чаще раза в 30 мин)
runTokenMonitor(bot).catch((err) => console.error("[token-monitor] loop error:", err));
setInterval(() => { runTokenMonitor(bot).catch((err) => console.error("[token-monitor] loop error:", err)); }, 60 * 1000);

// Планировщик по времени — тикает каждую минуту
const ALL_HOURS = Array.from({ length: 24 }, (_, h) => h);
const schedulerTick = createScheduler([
    { name: "stage-snapshot-00", hours: ALL_HOURS, minutes: 0, run: snapshotStageHistory },
    { name: "stage-snapshot-30", hours: ALL_HOURS, minutes: 30, run: snapshotStageHistory },
    // Каждый час в 00 минут (кроме 7 и 15) — тихий анализ, накапливаем статистику
    { name: "hhru-hourly", hours: [0,1,2,3,4,5,6,8,9,10,11,12,13,14,16,17,18,19,20,21,22,23], minutes: 0, run: runHhruHourly },
    // В 7:00 и 15:00 — анализ + сводка в группу
    { name: "hhru-report", hours: [7, 15], minutes: 0, run: runHhruWithReport },
]);
setInterval(schedulerTick, 60 * 1000);
