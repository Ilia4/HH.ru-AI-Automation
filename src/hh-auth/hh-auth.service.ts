import fs from "fs";
import path from "path";
import { loadTokens, saveTokens, type HhTokens } from "./token.store";

const REFRESH_LOCK = path.resolve(process.cwd(), "hh-refresh.lock");
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const AUTHORIZE_URL = "https://hh.ru/oauth/authorize";
const TOKEN_URL = "https://api.hh.ru/token";

function getConfig() {
    const clientId = process.env.HH_CLIENT_ID;
    const clientSecret = process.env.HH_CLIENT_SECRET;
    const redirectUri = process.env.HH_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
        throw new Error("HH_CLIENT_ID / HH_CLIENT_SECRET / HH_REDIRECT_URI не заданы в .env");
    }
    return { clientId, clientSecret, redirectUri };
}

/** Ссылка, которую открывает пользователь для авторизации */
export function buildAuthorizeUrl(state?: string): string {
    const { clientId, redirectUri } = getConfig();
    const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
    });
    if (state) params.set("state", state);
    return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Обмен authorization code на токены */
export async function exchangeCodeForTokens(code: string): Promise<HhTokens> {
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

    const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    saveTokens(data);
    return loadTokens()!;
}

/** Обновление access_token через refresh_token */
export async function refreshTokens(): Promise<HhTokens> {
    // Кросс-процессный лок: одновременно рефрешит только ОДИН процесс. Иначе HH ротирует
    // refresh_token и отзывает всю цепочку (token-revoked).
    let fd: number | null = null;
    for (let i = 0; i < 100; i++) {
        const t = loadTokens();
        if (!t?.refresh_token) throw new Error("Нет refresh_token — нужна повторная авторизация (/auth)");
        if (t.expires_at && Date.now() < t.expires_at) return t; // кто-то уже обновил
        try {
            fd = fs.openSync(REFRESH_LOCK, "wx");
            break;
        } catch {
            try {
                const st = fs.statSync(REFRESH_LOCK);
                if (Date.now() - st.mtimeMs > 30000) fs.unlinkSync(REFRESH_LOCK); // снимаем протухший лок
            } catch {}
            await sleep(300);
        }
    }
    if (fd === null) {
        const t = loadTokens();
        if (t) return t;
        throw new Error("Не удалось взять лок обновления токена");
    }
    try {
        const current = loadTokens();
        if (!current?.refresh_token) throw new Error("Нет refresh_token — нужна повторная авторизация (/auth)");
        if (current.expires_at && Date.now() < current.expires_at) return current;

        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: current.refresh_token,
        });
        const res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HH token refresh failed: ${res.status} ${text}`);
        }
        const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
        saveTokens(data);
        return loadTokens()!;
    } finally {
        try { if (fd !== null) fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(REFRESH_LOCK); } catch {}
    }
}

// Гарантируем, что обновление токена идёт строго в один поток (иначе HH отзывает цепочку).
let inFlightRefresh: Promise<HhTokens> | null = null;
function refreshTokensSingleFlight(): Promise<HhTokens> {
    if (!inFlightRefresh) {
        inFlightRefresh = refreshTokens().finally(() => { inFlightRefresh = null; });
    }
    return inFlightRefresh;
}

/** Возвращает валидный access_token, при необходимости обновляя его */
export async function getValidAccessToken(): Promise<string | null> {
    let tokens = loadTokens();
    if (!tokens) return null;

    if (Date.now() >= tokens.expires_at) {
        console.log("[hh-auth] access_token истёк, обновляю...");
        tokens = await refreshTokensSingleFlight();
    }
    return tokens.access_token;
}

export function isAuthorized(): boolean {
    return loadTokens() !== null;
}
