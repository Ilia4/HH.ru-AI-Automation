import fs from "fs";
import path from "path";

export type InterviewChatStatus =
    | "waiting_candidate_time"
    | "waiting_human_reply"
    | "waiting_candidate_confirmation"
    | "scheduled"
    | "closed";

export interface InterviewSlotProposal {
    date: string;
    time: string;
}

export interface InterviewChatState {
    negotiationId: string;
    vacancyId: string;
    vacancyName: string;
    spreadsheetId: string;
    candidateName: string;
    resumeUrl: string;
    messagesUrl: string;
    status: InterviewChatStatus;
    createdAt: string;
    updatedAt: string;
    lastProcessedMessageId?: string;
    lastProcessedMessageAt?: string;
    pendingTelegramChatId?: string;
    pendingTelegramThreadId?: number | null;
    pendingTelegramMessageId?: number;
    candidateLastMessage?: string;
    candidateProposedSlot?: InterviewSlotProposal | null;
    employerProposedSlot?: InterviewSlotProposal | null;
    scheduledSlot?: InterviewSlotProposal | null;
}

interface StoreData {
    items: Record<string, InterviewChatState>;
}

const STORE_PATH = path.resolve(process.cwd(), "interview-chat-state.json");

function emptyStore(): StoreData {
    return { items: {} };
}

function loadStore(): StoreData {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as StoreData;
        }
    } catch (error) {
        console.error("[interview-chat] не смог прочитать store:", error);
    }
    return emptyStore();
}

function saveStore(store: StoreData) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export function getInterviewChatState(negotiationId: string): InterviewChatState | null {
    const store = loadStore();
    return store.items[negotiationId] ?? null;
}

export function upsertInterviewChatState(state: InterviewChatState): InterviewChatState {
    const store = loadStore();
    store.items[state.negotiationId] = {
        ...store.items[state.negotiationId],
        ...state,
        updatedAt: new Date().toISOString(),
    };
    saveStore(store);
    return store.items[state.negotiationId];
}

export function updateInterviewChatState(
    negotiationId: string,
    patch: Partial<InterviewChatState>
): InterviewChatState {
    const store = loadStore();
    const current = store.items[negotiationId];
    if (!current) throw new Error(`state ${negotiationId} не найден`);

    const next: InterviewChatState = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
    store.items[negotiationId] = next;
    saveStore(store);
    return next;
}

export function listActiveInterviewChatStates(): InterviewChatState[] {
    const store = loadStore();
    return Object.values(store.items).filter((item) =>
        item.status !== "scheduled" && item.status !== "closed"
    );
}

export function findInterviewChatByTelegramMessage(chatId: string, messageId: number): InterviewChatState | null {
    const store = loadStore();
    return Object.values(store.items).find((item) =>
        item.pendingTelegramChatId === chatId &&
        item.pendingTelegramMessageId === messageId &&
        item.status === "waiting_human_reply"
    ) ?? null;
}
