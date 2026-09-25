/**
 * Простая авторизация панели: логин/пароль → подписанная httpOnly-cookie.
 * Пароль в .env (PANEL_PASSWORD). Если пароль не задан — авторизация выключена
 * (панель открыта), чтобы не заблокировать себя при мисконфиге.
 */
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const USER = process.env.PANEL_USER || "admin";
const PASSWORD = process.env.PANEL_PASSWORD || "";
const SECRET =
    process.env.PANEL_SECRET ||
    crypto.createHash("sha256").update("hr-panel::" + USER + "::" + PASSWORD).digest("hex");
const COOKIE = "hrp_auth";
const MAXAGE = 30 * 24 * 3600 * 1000; // 30 дней

export const authEnabled = (): boolean => PASSWORD.length > 0;

function sign(user: string): string {
    const h = crypto.createHmac("sha256", SECRET).update(user).digest("hex");
    return Buffer.from(user).toString("base64url") + "." + h;
}
function verify(token: string): boolean {
    if (!token) return false;
    const dot = token.lastIndexOf(".");
    if (dot < 1) return false;
    const user = Buffer.from(token.slice(0, dot), "base64url").toString();
    const h = token.slice(dot + 1);
    const good = crypto.createHmac("sha256", SECRET).update(user).digest("hex");
    if (h.length !== good.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(good)) && user === USER;
    } catch {
        return false;
    }
}
function readCookie(req: Request, name: string): string {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return "";
}

export function isAuthed(req: Request): boolean {
    if (!authEnabled()) return true;
    return verify(readCookie(req, COOKIE));
}

/** Гейт для защищённых /api-роутов. */
export function authGuard(req: Request, res: Response, next: NextFunction): void {
    if (isAuthed(req)) return next();
    res.status(401).json({ ok: false, auth: true, error: "требуется вход" });
}

export function sessionHandler(req: Request, res: Response): void {
    res.json({ ok: true, authEnabled: authEnabled(), authed: isAuthed(req), user: USER });
}

export function loginHandler(req: Request, res: Response): void {
    if (!authEnabled()) {
        res.json({ ok: true });
        return;
    }
    const { user, password } = (req.body || {}) as { user?: string; password?: string };
    const okUser = !user || String(user) === USER;
    const okPass = typeof password === "string" && password.length === PASSWORD.length &&
        crypto.timingSafeEqual(Buffer.from(String(password)), Buffer.from(PASSWORD));
    if (okUser && okPass) {
        res.cookie(COOKIE, sign(USER), {
            httpOnly: true,
            secure: true,
            sameSite: "lax",
            maxAge: MAXAGE,
            path: "/",
        });
        res.json({ ok: true });
        return;
    }
    res.status(401).json({ ok: false, error: "неверный логин или пароль" });
}

export function logoutHandler(_req: Request, res: Response): void {
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
}
