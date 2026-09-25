import fs from "fs";
import path from "path";

export type InterviewChatStatus =
    | "waiting_candidate_time"
    | "waiting_human_reply"
    | "waiting_candidate_confirmation"
    | "scheduled"
    | "confirm_requested"
    | "awaiting_candidate_confirm"
    | "awaiting_hr_cancel_text"
    | "confirmed"
    | "completed"
    | "closed";

export interface InterviewSlotProposal {
    date: string;
    time: string;
}

export interface InterviewTelegramContext {
    candidateMessage: string;
    candidateProposedSlot?: InterviewSlotProposal | null;
    createdAt: string;
}

export interface InterviewChatState {
    negotiationId: string;
    hhAccountId?: string;
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
    /**
     * Все карточки по кандидату, а не только последняя. Кандидат может написать
     * повторно («всё в силе?»), бот пришлёт новую карточку — и ответ на прежнюю
     * раньше терялся молча, потому что хранился один message_id.
     */
    pendingTelegramMessageIds?: number[];
    /** Контекст каждой карточки: reply на старую карточку не должен брать новый слот. */
    pendingTelegramContexts?: Record<string, InterviewTelegramContext>;
    candidateLastMessage?: string;
    candidateProposedSlot?: InterviewSlotProposal | null;
    employerProposedSlot?: InterviewSlotProposal | null;
    scheduledSlot?: InterviewSlotProposal | null;
    confirmationRequestedAt?: string;
    confirmTgMessageId?: number;
    cancelPromptTgChatId?: string;
    cancelPromptTgMessageId?: number;
    forwardTgChatId?: string;
    forwardedTgMessageIds?: number[];
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
        item.status !== "scheduled" && item.status !== "completed" && item.status !== "closed"
    );
}

// Для чат-роутера: слушаем и уже назначенных (scheduled) — чтобы отвечать на их вопросы
// до встречи. Не слушаем только закрытые диалоги.
export function listOpenInterviewChatStates(): InterviewChatState[] {
    const store = loadStore();
    return Object.values(store.items).filter((item) => item.status !== "closed");
}

export function findInterviewChatByTelegramMessage(chatId: string, messageId: number): InterviewChatState | null {
    const store = loadStore();
    return Object.values(store.items).find((item) =>
        item.pendingTelegramChatId === chatId &&
        (item.pendingTelegramMessageId === messageId ||
            (item.pendingTelegramMessageIds || []).includes(messageId)) &&
        item.status === "waiting_human_reply"
    ) ?? null;
}

export function findInterviewChatByCancelPrompt(chatId: string, messageId: number): InterviewChatState | null {
    const store = loadStore();
    return Object.values(store.items).find((item) =>
        item.cancelPromptTgChatId === chatId &&
        item.cancelPromptTgMessageId === messageId &&
        item.status === "awaiting_hr_cancel_text"
    ) ?? null;
}

// Найти диалог по id пересланного в тему сообщения кандидата (💬) — чтобы reply HR ушёл кандидату.
export function findInterviewChatByForwardedMessage(chatId: string, messageId: number): InterviewChatState | null {
    const store = loadStore();
    return Object.values(store.items).find((item) =>
        item.forwardTgChatId === chatId &&
        Array.isArray(item.forwardedTgMessageIds) &&
        item.forwardedTgMessageIds.includes(messageId)
    ) ?? null;
}
