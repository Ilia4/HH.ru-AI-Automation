import fs from "fs";
import path from "path";

const STORE_PATH = path.resolve(process.cwd(), "hh-tokens.json");

export interface HhTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // unix ms когда истекает access_token
}

export function loadTokens(): HhTokens | null {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        }
    } catch (err) {
        console.error("[hh-auth] ошибка чтения токенов:", err);
    }
    return null;
}

export function saveTokens(data: { access_token: string; refresh_token: string; expires_in: number }) {
    const tokens: HhTokens = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        // запас 60 секунд
        expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(tokens, null, 2), "utf-8");
    console.log("[hh-auth] токены сохранены, истекают:", new Date(tokens.expires_at).toISOString());
}

export function clearTokens() {
    try {
        if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    } catch {}
}
