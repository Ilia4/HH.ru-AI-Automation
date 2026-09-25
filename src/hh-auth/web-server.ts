import express from "express";
import type { Bot } from "grammy";
import { exchangeCodeForAccount } from "./hh-auth.service";
import { consumeOAuthSession } from "./accounts.service";

const PORT = Number(process.env.OAUTH_PORT) || 3000;

function htmlEscape(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

export function startOAuthServer(bot: Bot) {
    const app = express();

    app.get("/callback", async (req, res) => {
        const code = typeof req.query.code === "string" ? req.query.code : "";
        const state = typeof req.query.state === "string" ? req.query.state : "";
        const error = typeof req.query.error === "string" ? req.query.error : "";

        if (error) {
            console.error("[hh-auth] callback error:", error, req.query.error_description);
            res.status(400).send(`<h2>Ошибка авторизации: ${htmlEscape(error)}</h2>`);
            return;
        }
        if (!code || !state) {
            res.status(400).send("<h2>Ссылка авторизации неполная или устарела. Вернитесь в Telegram и нажмите «Добавить аккаунт» ещё раз.</h2>");
            return;
        }

        const session = await consumeOAuthSession(state);
        if (!session) {
            res.status(400).send("<h2>Ссылка авторизации истекла или уже использована. Вернитесь в Telegram и создайте новую.</h2>");
            return;
        }

        try {
            const account = await exchangeCodeForAccount(code, session.telegramUserId);
            console.log(`[hh-auth] аккаунт добавлен: ${account.email} (${account.id})`);
            res.send(`<h2>✅ Аккаунт HH.ru ${htmlEscape(account.email)} подключён! Можно закрыть вкладку и вернуться в Telegram.</h2>`);
            await bot.api.sendMessage(
                session.telegramChatId,
                [
                    "✅ Аккаунт HH.ru подключён.",
                    `Почта: ${account.email}`,
                    account.employerName ? `Работодатель: ${account.employerName}` : "",
                    "",
                    "Он начнёт обрабатывать вакансии, где эта почта указана в колонке «Аккаунт HH».",
                ].filter(Boolean).join("\n"),
            );
        } catch (err: any) {
            console.error("[hh-auth] ошибка обмена кода:", err.message);
            res.status(500).send(`<h2>Ошибка при подключении аккаунта: ${htmlEscape(err.message)}</h2>`);
            try {
                await bot.api.sendMessage(session.telegramChatId, `❌ Ошибка подключения HH.ru: ${err.message}`);
            } catch {}
        }
    });

    app.get("/health", (_req, res) => res.send("ok"));

    app.listen(PORT, () => {
        console.log(`[hh-auth] OAuth-сервер слушает порт ${PORT}`);
    });
}
