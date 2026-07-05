import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

export type ChatMessageRole = "candidate" | "assistant" | "system";
export type PendingSource = "kb_miss" | "ai_failed";

export interface ChatMessage {
    id: string;
    role: ChatMessageRole;
    text: string;
    source: "candidate" | "ai" | "human" | "system";
    createdAt: string;
}

export interface ChatSession {
    id: string;
    vacancyName: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
}

export interface PendingReply {
    id: string;
    sessionId: string;
    vacancyName: string;
    spreadsheetId: string;
    candidateQuestion: string;
    telegramChatId: string;
    telegramThreadId: number | null;
    telegramMessageId: number;
    source: PendingSource;
    createdAt: string;
    resolvedAt?: string;
    resolvedAnswer?: string;
    status: "pending" | "resolved";
}

interface ChatSimState {
    sessions: Record<string, ChatSession>;
    pendingReplies: Record<string, PendingReply>;
}

const STORE_PATH = path.resolve(process.cwd(), "chat-sim-state.json");

function emptyState(): ChatSimState {
    return { sessions: {}, pendingReplies: {} };
}

function loadState(): ChatSimState {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as ChatSimState;
        }
    } catch (error) {
        console.error("[chat-sim] не смог прочитать state:", error);
    }
    return emptyState();
}

function saveState(state: ChatSimState) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function createSession(vacancyName: string): ChatSession {
    const state = loadState();
    const now = new Date().toISOString();
    const session: ChatSession = {
        id: randomUUID(),
        vacancyName,
        createdAt: now,
        updatedAt: now,
        messages: [],
    };
    state.sessions[session.id] = session;
    saveState(state);
    return session;
}

export function getSession(sessionId: string): ChatSession | null {
    const state = loadState();
    return state.sessions[sessionId] ?? null;
}

export function appendSessionMessage(
    sessionId: string,
    role: ChatMessageRole,
    source: ChatMessage["source"],
    text: string
): ChatSession {
    const state = loadState();
    const session = state.sessions[sessionId];
    if (!session) throw new Error(`Сессия ${sessionId} не найдена`);

    session.messages.push({
        id: randomUUID(),
        role,
        source,
        text,
        createdAt: new Date().toISOString(),
    });
    session.updatedAt = new Date().toISOString();

    state.sessions[sessionId] = session;
    saveState(state);
    return session;
}

export function createPendingReply(
    pending: Omit<PendingReply, "id" | "createdAt" | "status">
): PendingReply {
    const state = loadState();
    const record: PendingReply = {
        ...pending,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: "pending",
    };
    state.pendingReplies[record.id] = record;
    saveState(state);
    return record;
}

export function findPendingReplyByTelegramMessage(chatId: string, messageId: number): PendingReply | null {
    const state = loadState();
    return Object.values(state.pendingReplies).find((item) =>
        item.telegramChatId === chatId &&
        item.telegramMessageId === messageId &&
        item.status === "pending"
    ) ?? null;
}

export function resolvePendingReply(id: string, answer: string): PendingReply {
    const state = loadState();
    const pending = state.pendingReplies[id];
    if (!pending) throw new Error(`Pending reply ${id} не найден`);

    pending.status = "resolved";
    pending.resolvedAt = new Date().toISOString();
    pending.resolvedAnswer = answer;

    state.pendingReplies[id] = pending;
    saveState(state);
    return pending;
}
