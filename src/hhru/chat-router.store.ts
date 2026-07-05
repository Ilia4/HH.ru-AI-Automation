import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const STORE_PATH = path.resolve(process.cwd(), "chat-router-state.json");

export interface Cursor {
    lastId: string;
    lastAt: string;
}

export interface PendingQa {
    id: string;
    negotiationId: string;
    messagesUrl: string;
    vacancyName: string;
    spreadsheetId: string;
    candidateQuestion: string;
    tgChatId: string;
    tgThreadId: number | null;
    tgMessageId: number;
    status: "pending" | "resolved";
    createdAt: string;
}

interface StoreData {
    cursors: Record<string, Cursor>;
    pendingQa: Record<string, PendingQa>;
}

function load(): StoreData {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as StoreData;
        }
    } catch (error) {
        console.error("[chat-router] не смог прочитать state:", error);
    }
    return { cursors: {}, pendingQa: {} };
}

function save(state: StoreData) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function getCursor(negotiationId: string): Cursor | null {
    return load().cursors[negotiationId] ?? null;
}

export function setCursor(negotiationId: string, cursor: Cursor) {
    const state = load();
    state.cursors[negotiationId] = cursor;
    save(state);
}

export function createPendingQa(p: Omit<PendingQa, "id" | "createdAt" | "status">): PendingQa {
    const state = load();
    const record: PendingQa = { ...p, id: randomUUID(), createdAt: new Date().toISOString(), status: "pending" };
    state.pendingQa[record.id] = record;
    save(state);
    return record;
}

export function findPendingQaByTgMessage(chatId: string, messageId: number): PendingQa | null {
    const state = load();
    return Object.values(state.pendingQa).find(
        (p) => p.tgChatId === chatId && p.tgMessageId === messageId && p.status === "pending"
    ) ?? null;
}

export function resolvePendingQa(id: string) {
    const state = load();
    const p = state.pendingQa[id];
    if (p) {
        p.status = "resolved";
        save(state);
    }
}
