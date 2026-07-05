import type { Bot, Context } from "grammy";
import { listTrackedVacancies, extractSpreadsheetId, readVacancyQa, appendVacancyQa } from "../chat-sim/vacancies";
import { decideCandidateAnswer } from "../chat-sim/ai-router";
import { askAi, parseAiJsonText } from "./ai-scorer";
import {
    getPhoneInterviewResponses,
    getConversationMessages,
    sendCandidateMessage,
    type HhMessage,
    type HhNegotiation,
} from "./hh-api";
import { findThreadId } from "./topics.store";
import { getInterviewChatState, listActiveInterviewChatStates } from "./interview-chat.store";
import { handleSchedulingMessage } from "./interview-chat";
import { getCursor, setCursor, createPendingQa, findPendingQaByTgMessage, resolvePendingQa } from "./chat-router.store";

// По умолчанию dry-run: ничего не уходит кандидатам, только логи. Боевой режим — CHAT_ROUTER_DRY_RUN=false.
const DRY = process.env.CHAT_ROUTER_DRY_RUN !== "false";

interface EngagedChat {
    negotiationId: string;
    messagesUrl: string;
    vacancyName: string;
    spreadsheetId: string;
    hasSchedulingState: boolean;
    candidateName: string;
}

function candName(n: HhNegotiation): string {
    return [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name].filter(Boolean).join(" ")
        || n.resume?.title || String(n.id);
}

function latest(messages: HhMessage[]): HhMessage | null {
    if (!messages.length) return null;
    return [...messages].sort((a, b) => {
        const aa = String(a.created_at || ""), bb = String(b.created_at || "");
        if (aa === bb) return String(a.id).localeCompare(String(b.id));
        return aa.localeCompare(bb);
    }).at(-1) ?? null;
}

function isNewer(m: HhMessage, cur: { lastId: string; lastAt: string } | null): boolean {
    if (!cur || !cur.lastAt) return true;
    const at = String(m.created_at || ""), id = String(m.id || "");
    if (at > cur.lastAt) return true;
    if (at === cur.lastAt && id > cur.lastId) return true;
    return false;
}

async function classifyIntent(text: string): Promise<"scheduling" | "question"> {
    const prompt = [
        "Классифицируй сообщение кандидата в чате по вакансии.",
        "Верни только JSON: {\"intent\":\"scheduling|question\",\"reason\":\"коротко\"}",
        "scheduling — кандидат про время/дату/перенос собеседования: предлагает слот, соглашается на время, просит перенести встречу.",
        "question — любой вопрос кандидата по вакансии (условия, задачи, зарплата, график, процесс, тестовое задание) или прочее общение.",
        "",
        `Сообщение кандидата: ${text}`,
    ].join("\n");
    try {
        const parsed = parseAiJsonText(await askAi(prompt));
        return parsed?.intent === "scheduling" ? "scheduling" : "question";
    } catch {
        return "question";
    }
}

async function escalateQuestionToTelegram(bot: Bot, chat: EngagedChat, question: string): Promise<void> {
    const groupChatId = process.env.GROUP_CHAT_ID;
    if (!groupChatId) {
        console.warn("[chat-router] GROUP_CHAT_ID не задан, эскалация невозможна");
        return;
    }
    const threadId = await findThreadId(bot, chat.vacancyName);
    const text = [
        `❓ Вопрос кандидата по вакансии «${chat.vacancyName}» (${chat.candidateName}) — в базе знаний ответа нет.`,
        "",
        "Вопрос кандидата:",
        question,
        "",
        "Ответьте reply на это сообщение — бот отправит ответ кандидату в чат HH и сохранит его в лист «Вопрос-ответ».",
    ].join("\n");
    const sent = await bot.api.sendMessage(groupChatId, text, threadId ? { message_thread_id: threadId } : {});
    createPendingQa({
        negotiationId: chat.negotiationId,
        messagesUrl: chat.messagesUrl,
        vacancyName: chat.vacancyName,
        spreadsheetId: chat.spreadsheetId,
        candidateQuestion: question,
        tgChatId: groupChatId,
        tgThreadId: threadId ?? null,
        tgMessageId: sent.message_id,
    });
}

async function answerQuestion(bot: Bot, chat: EngagedChat, question: string): Promise<void> {
    let kb;
    try {
        kb = await readVacancyQa(chat.spreadsheetId);
    } catch (e: any) {
        console.error("[chat-router] не смог прочитать базу знаний:", e.message);
        kb = [];
    }
    let decision;
    try {
        decision = await decideCandidateAnswer(chat.vacancyName, question, kb);
    } catch (e: any) {
        console.error("[chat-router] ошибка ИИ Q&A:", e.message);
        await escalateQuestionToTelegram(bot, chat, question);
        console.log(`[chat-router] ↑ эскалация (ИИ упал): ${chat.candidateName}`);
        return;
    }
    if (decision.decision === "answer" && decision.answer) {
        await sendCandidateMessage(chat.messagesUrl, decision.answer);
        console.log(`[chat-router] ✔ ответил кандидату ${chat.candidateName}: "${question.slice(0, 50)}"`);
    } else {
        await escalateQuestionToTelegram(bot, chat, question);
        console.log(`[chat-router] ↑ эскалация в Telegram: ${chat.candidateName}: "${question.slice(0, 50)}"`);
    }
}

// Бот общается ТОЛЬКО с прошедшими анкету — это ровно кандидаты, заведённые в диалог
// о собеседовании (registerInterviewConversation вызывается только при verdict «Прошёл»).
async function buildEngagedChats(): Promise<EngagedChat[]> {
    const chats: EngagedChat[] = [];
    for (const st of listActiveInterviewChatStates()) {
        if (st.status === "closed" || !st.messagesUrl) continue;
        chats.push({
            negotiationId: st.negotiationId,
            messagesUrl: st.messagesUrl,
            vacancyName: st.vacancyName,
            spreadsheetId: st.spreadsheetId,
            hasSchedulingState: true,
            candidateName: st.candidateName,
        });
    }
    return chats;
}

export async function runChatRouter(bot: Bot): Promise<void> {
    const chats = await buildEngagedChats();
    for (const chat of chats) {
        try {
            const messages = await getConversationMessages(chat.messagesUrl);
            const applicantMsgs = messages.filter((m) => m.author?.participant_type === "applicant");
            const newestOverall = latest(applicantMsgs);
            if (!newestOverall) continue;

            const cur = getCursor(chat.negotiationId);
            // первое появление чата — засеиваем курсор на текущее последнее сообщение и НЕ отвечаем на историю
            if (!cur) {
                setCursor(chat.negotiationId, {
                    lastId: String(newestOverall.id || ""),
                    lastAt: String(newestOverall.created_at || ""),
                });
                continue;
            }

            const fresh = applicantMsgs.filter((m) => isNewer(m, cur));
            if (fresh.length === 0) continue;

            const newest = latest(fresh)!;
            const text = String(newest.text || "").trim();
            const newCursor = { lastId: String(newest.id || ""), lastAt: String(newest.created_at || "") };

            if (!text) {
                setCursor(chat.negotiationId, newCursor);
                continue;
            }

            const schedState = chat.hasSchedulingState ? getInterviewChatState(chat.negotiationId) : null;
            let route: "scheduling" | "qa";
            let intent = "";
            if (schedState && schedState.status === "waiting_candidate_confirmation") {
                // Мы предложили кандидату слот и ждём его ответ (да/нет/другое время).
                // Короткое «да, вполне» — это ответ по слоту, а НЕ вопрос в базу знаний.
                route = "scheduling";
                intent = "scheduling(confirm)";
            } else {
                intent = await classifyIntent(text);
                route = intent === "scheduling" && chat.hasSchedulingState ? "scheduling" : "qa";
            }

            if (DRY) {
                console.log(`[chat-router:DRY] ${chat.vacancyName} / ${chat.candidateName}: intent=${intent} route=${route} msg="${text.slice(0, 60)}"`);
                continue; // курсор не двигаем — при включении боевого режима сообщение обработается
            }

            setCursor(chat.negotiationId, newCursor);
            if (route === "scheduling" && schedState) {
                await handleSchedulingMessage(bot, schedState, text);
            } else {
                await answerQuestion(bot, chat, text);
            }
        } catch (error) {
            console.error(`[chat-router] ошибка по negotiation ${chat.negotiationId}:`, error);
        }
    }
}

export function registerHhQaReplyHandler(bot: Bot<Context>) {
    bot.on("message:text", async (ctx, next) => {
        const message = ctx.message;
        const groupChatId = process.env.GROUP_CHAT_ID;
        if (!groupChatId || String(ctx.chat.id) !== groupChatId) return next();
        if (!message.reply_to_message) return next();

        const pending = findPendingQaByTgMessage(String(ctx.chat.id), message.reply_to_message.message_id);
        if (!pending) return next();

        const answer = String(message.text || "").trim();
        if (!answer) return next();

        try {
            await sendCandidateMessage(pending.messagesUrl, answer);
            let saved = "";
            try {
                const r = await appendVacancyQa(pending.spreadsheetId, pending.candidateQuestion, answer);
                saved = r.appended
                    ? " Сохранил в лист «Вопрос-ответ»."
                    : ` В базу не добавил: вопрос уже есть как «${r.duplicateQuestion}».`;
            } catch (e: any) {
                saved = ` (в базу не сохранил: ${e.message})`;
            }
            resolvePendingQa(pending.id);
            await ctx.reply(`Отправил ответ кандидату в HH.${saved}`, {
                reply_parameters: { message_id: message.message_id },
            });
        } catch (error: any) {
            console.error("[chat-router] ошибка отправки ответа кандидату:", error);
            await ctx.reply(`Не смог отправить ответ кандидату: ${error.message}`, {
                reply_parameters: { message_id: message.message_id },
            });
        }
    });
}
