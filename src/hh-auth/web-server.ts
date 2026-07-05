import express from "express";
import type { Bot } from "grammy";
import { exchangeCodeForTokens } from "./hh-auth.service";

const PORT = Number(process.env.OAUTH_PORT) || 3000;

export function startOAuthServer(bot: Bot) {
    const app = express();

    app.get("/callback", async (req, res) => {
        const code = req.query.code as string | undefined;
        const state = req.query.state as string | undefined; // chat_id админа
        const error = req.query.error as string | undefined;

        if (error) {
            console.error("[hh-auth] callback error:", error, req.query.error_description);
            res.status(400).send(`<h2>Ошибка авторизации: ${error}</h2>`);
            return;
        }

        if (!code) {
            res.status(400).send("<h2>Нет кода авторизации</h2>");
            return;
        }

        try {
            await exchangeCodeForTokens(code);
            console.log("[hh-auth] авторизация успешна");
            res.send("<h2>✅ Авторизация HH.ru успешна! Можно закрыть вкладку и вернуться в Telegram.</h2>");

            if (state) {
                try {
                    await bot.api.sendMessage(state, "✅ Авторизация HH.ru прошла успешно. Токен сохранён.");
                } catch (e) {
                    console.error("[hh-auth] не смог уведомить в telegram:", e);
                }
            }
        } catch (err: any) {
            console.error("[hh-auth] ошибка обмена кода:", err.message);
            res.status(500).send(`<h2>Ошибка при получении токена: ${err.message}</h2>`);
            if (state) {
                try {
                    await bot.api.sendMessage(state, `❌ Ошибка авторизации HH.ru: ${err.message}`);
                } catch {}
            }
        }
    });

    app.get("/health", (_req, res) => res.send("ok"));

    app.listen(PORT, () => {
        console.log(`[hh-auth] OAuth-сервер слушает порт ${PORT}`);
    });
}
