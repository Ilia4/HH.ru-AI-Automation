import type { Bot, Context } from "grammy";
import { InlineKeyboard, Keyboard } from "grammy";
import { prisma } from "../lib/prisma";
import { buildAuthorizeUrl } from "./hh-auth.service";
import { createOAuthSession, getHhAccount, listHhAccounts } from "./accounts.service";
import { isAdminTelegramId } from "../auth/admin";

export const ACCOUNTS_BUTTON = "👤 Аккаунты HH.ru";
export const AUTH_BUTTON = "🔑 Авторизация";

export function privateMainKeyboard() {
    return new Keyboard()
        .text(ACCOUNTS_BUTTON)
        .text(AUTH_BUTTON)
        .resized()
        .persistent();
}

function isAdminPrivate(ctx: Context): boolean {
    return ctx.chat?.type === "private" && !!ctx.from && isAdminTelegramId(ctx.from.id);
}

/**
 * Раньше команда от не-админа просто игнорировалась, и человек не понимал,
 * сломался бот или он сам делает что-то не то. Теперь отвечаем прямо.
 * В группах по-прежнему молчим, чтобы не засорять общий чат.
 */
async function denyIfNotAdmin(ctx: Context): Promise<boolean> {
    if (isAdminPrivate(ctx)) return false;
    if (ctx.chat?.type === "private") {
        await ctx.reply("Эта команда доступна только администраторам бота. Если доступ нужен — попросите добавить вас.");
    }
    return true;
}

function statusIcon(status: string): string {
    if (status === "active") return "✅";
    if (status === "disabled") return "⚪";
    return "🔴";
}

async function addAccountLink(ctx: Context) {
    if (await denyIfNotAdmin(ctx)) return;
    if (!isAdminPrivate(ctx) || !ctx.chat || !ctx.from) return;
    const session = await createOAuthSession(String(ctx.chat.id), String(ctx.from.id));
    const url = buildAuthorizeUrl(session.state);
    await ctx.reply(
        [
            "Откройте HH.ru и войдите в аккаунт, который нужно добавить.",
            "Если HH.ru предлагает продолжить под уже открытым аккаунтом, выберите «Войти под другим аккаунтом».",
            "",
            "Ссылка действует 15 минут.",
        ].join("\n"),
        { reply_markup: new InlineKeyboard().url("➕ Авторизовать аккаунт HH.ru", url) },
    );
}

async function showAccounts(ctx: Context) {
    if (await denyIfNotAdmin(ctx)) return;
    if (!isAdminPrivate(ctx)) return;
    const accounts = await listHhAccounts(true);
    const lines = accounts.length
        ? accounts.map((a, i) => `${i + 1}. ${statusIcon(a.status)} ${a.email}${a.employerName ? ` — ${a.employerName}` : ""}`)
        : ["Подключённых аккаунтов пока нет."];

    const keyboard = new InlineKeyboard();
    for (const account of accounts) {
        keyboard.text(`${statusIcon(account.status)} ${account.email}`, `hhacc:${account.id}`).row();
    }
    keyboard.text("➕ Добавить аккаунт", "hhacc:add").text("🔄 Обновить", "hhacc:list");

    await ctx.reply(["Аккаунты HH.ru:", "", ...lines].join("\n"), { reply_markup: keyboard });
}

async function showAccountDetails(ctx: Context, accountId: string) {
    if (!isAdminPrivate(ctx)) return;
    const account = await getHhAccount(accountId);
    if (!account) {
        await ctx.reply("Аккаунт уже не найден.");
        return;
    }
    const vacancies = await prisma.activeVacancy.count({
        where: { hhAccountId: account.id, isActive: true },
    });
    const checked = account.lastCheckedAt
        ? account.lastCheckedAt.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })
        : "ещё не проверялся";
    await ctx.reply(
        [
            `${statusIcon(account.status)} ${account.email}`,
            account.employerName ? `Работодатель: ${account.employerName}` : "",
            account.managerId ? `Manager ID: ${account.managerId}` : "",
            `Статус: ${account.status}`,
            `Активных вакансий: ${vacancies}`,
            `Последняя проверка: ${checked}`,
            account.lastError ? `Последняя ошибка: ${account.lastError}` : "",
        ].filter(Boolean).join("\n"),
        { reply_markup: new InlineKeyboard().text("← Все аккаунты", "hhacc:list").text("➕ Добавить", "hhacc:add") },
    );
}

export function registerHhAccountsMenu(bot: Bot<Context>) {
    bot.command("accounts", showAccounts);
    bot.command("auth", addAccountLink);
    bot.hears(ACCOUNTS_BUTTON, showAccounts);
    bot.hears(AUTH_BUTTON, addAccountLink);
    bot.hears(/^авторизац(ия|ию)$/i, addAccountLink);

    bot.callbackQuery("hhacc:list", async (ctx) => {
        await ctx.answerCallbackQuery();
        await showAccounts(ctx);
    });
    bot.callbackQuery("hhacc:add", async (ctx) => {
        await ctx.answerCallbackQuery();
        await addAccountLink(ctx);
    });
    bot.callbackQuery(/^hhacc:(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        await showAccountDetails(ctx, ctx.match[1]);
    });
}
