import type { Bot } from "grammy";
import fs from "fs";
import path from "path";
import { checkHhAuth } from "../hhru/hh-api";
import { listHhAccounts } from "../hh-auth/accounts.service";
import { prisma } from "../lib/prisma";

const ALERT_COOLDOWN_MS = 7 * 60 * 60 * 1000;
const STATE_PATH = path.resolve(process.cwd(), "token-monitor-state.json");

interface AccountMonitorState {
    broken: boolean;
    lastAlertAt: number;
}

interface MonitorState {
    accounts: Record<string, AccountMonitorState>;
}

function loadState(accountIds: string[]): MonitorState {
    try {
        if (fs.existsSync(STATE_PATH)) {
            const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
            if (raw?.accounts && typeof raw.accounts === "object") return raw as MonitorState;
            // Совместимость со старым одноаккаунтным состоянием. Благодаря этому
            // после обновления бот не повторит уже отправленное предупреждение.
            if (accountIds.length && typeof raw?.broken === "boolean") {
                return {
                    accounts: {
                        [accountIds[0]]: {
                            broken: !!raw.broken,
                            lastAlertAt: Number(raw.lastAlertAt) || 0,
                        },
                    },
                };
            }
        }
    } catch {}
    return { accounts: {} };
}

function saveState(state: MonitorState) {
    try {
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
    } catch (e: any) {
        console.error("[token-monitor] не смог сохранить состояние:", e.message);
    }
}

async function sendToGeneral(bot: Bot, text: string): Promise<void> {
    const groupId = process.env.GROUP_CHAT_ID;
    if (!groupId) return;
    try {
        await bot.api.sendMessage(groupId, text);
    } catch (e: any) {
        console.error("[token-monitor] не смог отправить в General:", e.message);
    }
}

export async function runTokenMonitor(bot: Bot): Promise<void> {
    if (!process.env.GROUP_CHAT_ID) return;
    const accounts = await listHhAccounts();
    if (!accounts.length) return;

    const state = loadState(accounts.map((a) => a.id));

    for (const account of accounts) {
        let result;
        try {
            result = await checkHhAuth(account.id);
        } catch (e: any) {
            console.error(`[token-monitor] ошибка проверки ${account.email}:`, e.message);
            continue;
        }
        if (result.network) continue;

        const accountState = state.accounts[account.id] || { broken: false, lastAlertAt: 0 };
        const now = Date.now();

        if (!result.ok) {
            await prisma.hhAccount.update({
                where: { id: account.id },
                data: {
                    status: "reauth_required",
                    lastCheckedAt: new Date(),
                    lastError: result.reason,
                    lastErrorAt: new Date(),
                },
            });
            if (!accountState.broken || now - accountState.lastAlertAt >= ALERT_COOLDOWN_MS) {
                await sendToGeneral(
                    bot,
                    [
                        "🔴 Бот потерял доступ к аккаунту HH.ru.",
                        `Аккаунт: ${account.email}`,
                        account.employerName ? `Работодатель: ${account.employerName}` : "",
                        `Причина: ${result.reason}.`,
                        "",
                        "Вакансии этого аккаунта временно не обрабатываются. Остальные аккаунты продолжают работать.",
                        "Откройте личку бота → «Аккаунты HH.ru» → «Добавить аккаунт» и авторизуйте эту почту повторно.",
                    ].filter(Boolean).join("\n"),
                );
                accountState.lastAlertAt = now;
            }
            accountState.broken = true;
        } else {
            if (accountState.broken) {
                await sendToGeneral(bot, `✅ Доступ к HH.ru восстановлен: ${account.email}`);
            }
            accountState.broken = false;
            accountState.lastAlertAt = 0;
            await prisma.hhAccount.update({
                where: { id: account.id },
                data: {
                    status: "active",
                    lastCheckedAt: new Date(),
                    lastSuccessAt: new Date(),
                    lastError: null,
                    lastErrorAt: null,
                    hhUserId: result.identity?.hhUserId || account.hhUserId,
                    managerId: result.identity?.managerId || account.managerId,
                    employerId: result.identity?.employerId || account.employerId,
                    employerName: result.identity?.employerName || account.employerName,
                },
            });
        }
        state.accounts[account.id] = accountState;
    }

    saveState(state);
}
