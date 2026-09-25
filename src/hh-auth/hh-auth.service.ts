import fs from "fs";
import path from "path";
import { currentHhAccountId } from "./account-context";
import {
    getHhAccount,
    resolveHhAccountId,
    saveAuthorizedAccount,
    type HhAccountIdentity,
    type OAuthTokenResponse,
} from "./accounts.service";
import { decryptToken, encryptToken } from "./token.crypto";
import { prisma } from "../lib/prisma";

const AUTHORIZE_URL = "https://hh.ru/oauth/authorize";
const TOKEN_URL = "https://api.hh.ru/token";
const USER_AGENT = process.env.HH_USER_AGENT || "hr-tg-bot/1.0 (gf12658@gmail.com)";

function getConfig() {
    const clientId = process.env.HH_CLIENT_ID;
    const clientSecret = process.env.HH_CLIENT_SECRET;
    const redirectUri = process.env.HH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
        throw new Error("HH_CLIENT_ID / HH_CLIENT_SECRET / HH_REDIRECT_URI не заданы в .env");
    }
    return { clientId, clientSecret, redirectUri };
}

export function buildAuthorizeUrl(state: string): string {
    const { clientId, redirectUri } = getConfig();
    const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function requestIdentity(accessToken: string): Promise<HhAccountIdentity> {
    const res = await fetch("https://api.hh.ru/me", {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "HH-User-Agent": USER_AGENT,
        },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HH /me failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const me: any = await res.json();
    return {
        hhUserId: me?.id != null ? String(me.id) : undefined,
        managerId: me?.manager?.id != null ? String(me.manager.id) : undefined,
        employerId: me?.employer?.id != null ? String(me.employer.id) : undefined,
        employerName: me?.employer?.name || undefined,
        email: me?.email || undefined,
    };
}

export async function exchangeCodeForAccount(
    code: string,
    createdByTgId?: string,
) {
    const { clientId, clientSecret, redirectUri } = getConfig();
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
    });
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HH token exchange failed: ${res.status} ${text}`);
    }
    const tokens = await res.json() as OAuthTokenResponse;
    const identity = await requestIdentity(tokens.access_token);
    return saveAuthorizedAccount(identity, tokens, createdByTgId);
}

const inFlightRefresh = new Map<string, Promise<string>>();

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function refreshLockPath(accountId: string) {
    return path.resolve(process.cwd(), `hh-refresh-${accountId.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
}

async function refreshAccountToken(accountId: string): Promise<string> {
    const lockPath = refreshLockPath(accountId);
    let fd: number | null = null;

    for (let i = 0; i < 100; i++) {
        const latest = await getHhAccount(accountId);
        if (!latest) throw new Error(`HH-аккаунт ${accountId} не найден`);
        if (latest.status === "disabled") throw new Error(`HH-аккаунт ${latest.email} отключён`);
        if (latest.status === "reauth_required") throw new Error(`HH-аккаунт ${latest.email} требует повторной авторизации`);
        if (Date.now() < latest.expiresAt.getTime()) return decryptToken(latest.accessTokenEncrypted);

        try {
            fd = fs.openSync(lockPath, "wx");
            break;
        } catch {
            try {
                const st = fs.statSync(lockPath);
                if (Date.now() - st.mtimeMs > 30_000) fs.unlinkSync(lockPath);
            } catch {}
            await sleep(300);
        }
    }

    if (fd === null) throw new Error(`Не удалось взять блокировку refresh для HH-аккаунта ${accountId}`);

    try {
        const account = await getHhAccount(accountId);
        if (!account) throw new Error(`HH-аккаунт ${accountId} не найден`);
        if (Date.now() < account.expiresAt.getTime()) return decryptToken(account.accessTokenEncrypted);

        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: decryptToken(account.refreshTokenEncrypted),
        });
        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        if (!res.ok) {
            const text = await res.text();
            await prisma.hhAccount.update({
                where: { id: accountId },
                data: {
                    status: "reauth_required",
                    lastError: `refresh ${res.status}: ${text.slice(0, 500)}`,
                    lastErrorAt: new Date(),
                },
            });
            throw new Error(`HH token refresh failed for ${account.email}: ${res.status} ${text}`);
        }

        const data = await res.json() as OAuthTokenResponse;
        await prisma.hhAccount.update({
            where: { id: accountId },
            data: {
                accessTokenEncrypted: encryptToken(data.access_token),
                refreshTokenEncrypted: encryptToken(data.refresh_token),
                expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000),
                status: "active",
                lastError: null,
                lastErrorAt: null,
                lastSuccessAt: new Date(),
            },
        });
        return data.access_token;
    } finally {
        try { if (fd !== null) fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
    }
}

export async function getValidAccessToken(explicitAccountId?: string | null): Promise<string | null> {
    const accountId = await resolveHhAccountId(explicitAccountId || currentHhAccountId());
    if (!accountId) {
        throw new Error("Не выбран аккаунт HH.ru: при нескольких аккаунтах требуется accountId");
    }
    const account = await getHhAccount(accountId);
    if (!account) return null;
    if (account.status === "disabled") throw new Error(`HH-аккаунт ${account.email} отключён`);
    if (account.status === "reauth_required") throw new Error(`HH-аккаунт ${account.email} требует повторной авторизации`);
    if (Date.now() < account.expiresAt.getTime()) {
        return decryptToken(account.accessTokenEncrypted);
    }

    let pending = inFlightRefresh.get(accountId);
    if (!pending) {
        pending = refreshAccountToken(accountId).finally(() => inFlightRefresh.delete(accountId));
        inFlightRefresh.set(accountId, pending);
    }
    return pending;
}

export async function isAuthorized(): Promise<boolean> {
    return (await prisma.hhAccount.count({ where: { status: { not: "disabled" } } })) > 0;
}
