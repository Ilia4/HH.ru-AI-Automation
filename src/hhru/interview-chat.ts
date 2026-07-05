import type { Bot, Context } from "grammy";
import { askAi, parseAiJsonText } from "./ai-scorer";
import { appendInterviewBooking, isInterviewSlotAvailable, isTimeInAllowedWindow, isWeekend, normalizeDate, normalizeTime } from "./interview-calendar";
import {
    findInterviewChatByTelegramMessage,
    getInterviewChatState,
    listActiveInterviewChatStates,
    updateInterviewChatState,
    upsertInterviewChatState,
    type InterviewChatState,
    type InterviewSlotProposal,
} from "./interview-chat.store";
import { extractSpreadsheetId } from "./sheets-analysis";
import { findThreadId } from "./topics.store";
import { getConversationMessages, sendCandidateMessage, getNegotiation, extractActions, doNegotiationAction, type HhMessage, type HhNegotiation } from "./hh-api";

interface CandidateDecision {
    action: "propose_time" | "accept_time" | "question" | "unclear";
    date: string;
    time: string;
    reason: string;
}

interface HumanDecision {
    action: "confirm_candidate_time" | "offer_new_time" | "ask_candidate" | "reject_without_slot";
    candidate_reply: string;
    date: string;
    time: string;
    reason: string;
}

function latestMessage(messages: HhMessage[]): HhMessage | null {
    if (messages.length === 0) return null;
    return [...messages].sort((a, b) => {
        if ((a.created_at || "") === (b.created_at || "")) {
            return String(a.id).localeCompare(String(b.id));
        }
        return String(a.created_at || "").localeCompare(String(b.created_at || ""));
    }).at(-1) ?? null;
}

function isNewerMessage(message: HhMessage, state: InterviewChatState): boolean {
    const lastAt = state.lastProcessedMessageAt || "";
    const lastId = state.lastProcessedMessageId || "";
    const currentAt = String(message.created_at || "");
    const currentId = String(message.id || "");
    if (!lastAt) return true;
    if (currentAt > lastAt) return true;
    if (currentAt === lastAt && currentId > lastId) return true;
    return false;
}

function buildCandidatePrompt(message: string, pendingEmployerSlot?: InterviewSlotProposal | null): string {
    const now = new Date().toISOString();
    return [
        "Ты анализируешь ответ кандидата по согласованию собеседования.",
        `Текущая дата: ${now}`,
        pendingEmployerSlot
            ? `Работодатель предложил слот: ${pendingEmployerSlot.date} ${pendingEmployerSlot.time}`
            : "Сейчас работодатель ещё не предлагал новый слот.",
        "",
        "Нужно вернуть только JSON:",
        "{\"action\":\"propose_time|accept_time|question|unclear\",\"date\":\"YYYY-MM-DD или пусто\",\"time\":\"HH:MM или пусто\",\"reason\":\"коротко\"}",
        "",
        "Правила:",
        "- propose_time: кандидат предлагает конкретную дату/время",
        "- accept_time: кандидат соглашается на уже предложенный работодателем слот",
        "- question: кандидат задаёт вопрос или просит уточнение без явного подтверждения слота",
        "- unclear: ничего из этого понять нельзя",
        "",
        `Сообщение кандидата: ${message}`,
    ].join("\n");
}

function buildHumanPrompt(candidateMessage: string, humanReply: string, candidateSlot?: InterviewSlotProposal | null): string {
    const now = new Date().toISOString();
    const slotHint = candidateSlot ? `${candidateSlot.date} ${candidateSlot.time}` : "кандидат конкретный слот не предложил";
    return [
        "Ты помогаешь оформить ответ ответственного по согласованию собеседования.",
        `Текущая дата: ${now}`,
        `Последнее сообщение кандидата: ${candidateMessage}`,
        `Кандидат предложил слот: ${slotHint}`,
        `Ответ ответственного: ${humanReply}`,
        "",
        "Верни только JSON:",
        "{\"action\":\"confirm_candidate_time|offer_new_time|ask_candidate|reject_without_slot\",\"candidate_reply\":\"вежливый ответ кандидату без искажения смысла\",\"date\":\"YYYY-MM-DD или пусто\",\"time\":\"HH:MM или пусто\",\"reason\":\"коротко\"}",
        "",
        "Правила:",
        "- confirm_candidate_time: ответственный согласен на слот кандидата",
        "- offer_new_time: ответственный предлагает другой конкретный слот",
        "- ask_candidate: нужно просто задать кандидату уточнение или дополнительный вопрос",
        "- reject_without_slot: предложенный кандидатом слот не подходит, но нового точного времени пока нет",
        "- candidate_reply можно слегка отредактировать по орфографии и пунктуации, но нельзя менять смысл",
    ].join("\n");
}

async function classifyCandidateMessage(message: string, pendingEmployerSlot?: InterviewSlotProposal | null): Promise<CandidateDecision> {
    const raw = await askAi(buildCandidatePrompt(message, pendingEmployerSlot));
    const parsed = parseAiJsonText(raw);
    return {
        action: parsed.action,
        date: String(parsed.date || "").trim(),
        time: String(parsed.time || "").trim(),
        reason: String(parsed.reason || "").trim(),
    };
}

async function classifyHumanReply(candidateMessage: string, humanReply: string, candidateSlot?: InterviewSlotProposal | null): Promise<HumanDecision> {
    const raw = await askAi(buildHumanPrompt(candidateMessage, humanReply, candidateSlot));
    const parsed = parseAiJsonText(raw);
    return {
        action: parsed.action,
        candidate_reply: String(parsed.candidate_reply || "").trim(),
        date: String(parsed.date || "").trim(),
        time: String(parsed.time || "").trim(),
        reason: String(parsed.reason || "").trim(),
    };
}

function validateSlot(slot: InterviewSlotProposal): string | null {
    const date = normalizeDate(slot.date);
    const time = normalizeTime(slot.time);
    if (!date || !time) return "не удалось распознать дату или время";
    if (isWeekend(date)) return "нельзя назначать собеседование на субботу или воскресенье";
    if (!isTimeInAllowedWindow(time)) return "время должно быть в интервале 10:00-17:00 по будням";
    return null;
}

async function sendToTelegram(bot: Bot, state: InterviewChatState, text: string): Promise<InterviewChatState> {
    const groupChatId = process.env.GROUP_CHAT_ID;
    if (!groupChatId) throw new Error("GROUP_CHAT_ID не задан в .env");
    const threadId = await findThreadId(bot, state.vacancyName);
    const sent = await bot.api.sendMessage(groupChatId, text, threadId ? { message_thread_id: threadId } : {});

    return updateInterviewChatState(state.negotiationId, {
        status: "waiting_human_reply",
        pendingTelegramChatId: groupChatId,
        pendingTelegramThreadId: threadId,
        pendingTelegramMessageId: sent.message_id,
    });
}

async function scheduleConfirmedSlot(bot: Bot, state: InterviewChatState, slot: InterviewSlotProposal): Promise<void> {
    const normalizedSlot = { date: normalizeDate(slot.date), time: normalizeTime(slot.time) };
    const validationError = validateSlot(normalizedSlot);
    if (validationError) throw new Error(validationError);

    const available = await isInterviewSlotAvailable(normalizedSlot);
    if (!available) throw new Error(`слот ${normalizedSlot.date} ${normalizedSlot.time} уже занят`);

    await appendInterviewBooking({
        vacancyName: state.vacancyName,
        candidateFullName: state.candidateName,
        resumeUrl: state.resumeUrl,
        date: normalizedSlot.date,
        time: normalizedSlot.time,
        contactCandidate: "HH chat",
    });

    // Дата/время согласованы → переводим кандидата в стадию «Собеседование» на HH
    try {
        const hh = await getNegotiation(state.negotiationId);
        const actions = hh ? extractActions(hh) : null;
        if (actions?.action_interview_url) {
            await doNegotiationAction(actions.action_interview_url, actions.action_interview_method);
        } else {
            console.warn(`[interview-chat] нет action_interview для ${state.negotiationId}, стадия не изменена`);
        }
    } catch (e) {
        console.error(`[interview-chat] не смог перевести в «Собеседование» ${state.negotiationId}:`, e);
    }

    updateInterviewChatState(state.negotiationId, {
        status: "scheduled",
        scheduledSlot: normalizedSlot,
        candidateProposedSlot: null,
        employerProposedSlot: null,
        pendingTelegramChatId: undefined,
        pendingTelegramThreadId: undefined,
        pendingTelegramMessageId: undefined,
    });

    // Уведомляем HR в теме вакансии — чтобы назначенные встречи всегда были на виду
    try {
        const groupChatId = process.env.GROUP_CHAT_ID;
        if (groupChatId) {
            const threadId = await findThreadId(bot, state.vacancyName);
            const text = `✅ Собеседование назначено\nКандидат: ${state.candidateName}\nВакансия: ${state.vacancyName}\nКогда: ${normalizedSlot.date} в ${normalizedSlot.time}`;
            await bot.api.sendMessage(groupChatId, text, threadId ? { message_thread_id: threadId } : {});
        }
    } catch (e) {
        console.error(`[interview-chat] не смог уведомить о назначенной встрече:`, e);
    }
}

export async function registerInterviewConversation(
    vacancy: { vacancyId: string; vacancyName: string; templatesUrl?: string | null },
    candidate: HhNegotiation
): Promise<void> {
    if (!candidate.messages_url) return;
    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return;

    const existing = getInterviewChatState(candidate.id);
    if (existing && existing.status !== "closed") return;

    const messages = await getConversationMessages(candidate.messages_url);
    const last = latestMessage(messages);
    upsertInterviewChatState({
        negotiationId: candidate.id,
        vacancyId: vacancy.vacancyId,
        vacancyName: vacancy.vacancyName,
        spreadsheetId,
        candidateName: [candidate.resume?.last_name, candidate.resume?.first_name, candidate.resume?.middle_name].filter(Boolean).join(" ") || candidate.resume?.title || "Candidate",
        resumeUrl: candidate.resume?.alternate_url || candidate.resume?.url || "",
        messagesUrl: candidate.messages_url,
        status: "waiting_candidate_time",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastProcessedMessageId: last?.id ? String(last.id) : undefined,
        lastProcessedMessageAt: last?.created_at || undefined,
        candidateProposedSlot: null,
        employerProposedSlot: null,
        scheduledSlot: null,
    });
}

export async function handleSchedulingMessage(bot: Bot, state: InterviewChatState, text: string): Promise<void> {
    const updated = updateInterviewChatState(state.negotiationId, {
        candidateLastMessage: text,
    });

    const candidateDecision = await classifyCandidateMessage(text, updated.employerProposedSlot);

    if (updated.status === "waiting_candidate_confirmation" && candidateDecision.action === "accept_time" && updated.employerProposedSlot) {
        await scheduleConfirmedSlot(bot, updated, updated.employerProposedSlot);
        await sendCandidateMessage(updated.messagesUrl, "Отлично, договорились. Мы записали вас на собеседование.");
        return;
    }

    const proposal = candidateDecision.action === "propose_time" && candidateDecision.date && candidateDecision.time
        ? { date: candidateDecision.date, time: candidateDecision.time }
        : null;

    updateInterviewChatState(state.negotiationId, {
        candidateProposedSlot: proposal,
        employerProposedSlot: updated.status === "waiting_candidate_confirmation" ? updated.employerProposedSlot : null,
    });

    const telegramText = [
        `🗓 Кандидат ответил по собеседованию: ${updated.candidateName}`,
        `Вакансия: ${updated.vacancyName}`,
        "",
        `Сообщение кандидата:`,
        text || "(пустое сообщение)",
        "",
        proposal ? `Кандидат предлагает слот: ${proposal.date} ${proposal.time}` : "Точный слот из сообщения кандидата не распознан.",
        "",
        "Ответьте reply на это сообщение.",
        "Бот сам классифицирует ответ: подтверждение, новый слот или уточнение.",
    ].join("\n");

    await sendToTelegram(bot, updated, telegramText);
}

export async function processInterviewChatConversations(bot: Bot): Promise<void> {
    const states = listActiveInterviewChatStates();
    for (const state of states) {
        if (state.status === "waiting_human_reply") continue;

        try {
            const messages = await getConversationMessages(state.messagesUrl);
            const newApplicantMessages = messages
                .filter((message) => message.author?.participant_type === "applicant")
                .filter((message) => isNewerMessage(message, state));

            if (newApplicantMessages.length === 0) continue;

            const newest = latestMessage(newApplicantMessages);
            if (!newest) continue;

            updateInterviewChatState(state.negotiationId, {
                lastProcessedMessageId: newest.id ? String(newest.id) : state.lastProcessedMessageId,
                lastProcessedMessageAt: newest.created_at || state.lastProcessedMessageAt,
            });

            await handleSchedulingMessage(bot, state, String(newest.text || "").trim());
        } catch (error) {
            console.error(`[interview-chat] ошибка по negotiation ${state.negotiationId}:`, error);
        }
    }
}

export function registerInterviewTelegramReplyHandler(bot: Bot<Context>) {
    bot.on("message:text", async (ctx, next) => {
        const message = ctx.message;
        const groupChatId = process.env.GROUP_CHAT_ID;
        if (!groupChatId || String(ctx.chat.id) !== groupChatId) return next();
        if (!message.reply_to_message) return next();

        const state = findInterviewChatByTelegramMessage(String(ctx.chat.id), message.reply_to_message.message_id);
        if (!state) return next();

        const humanReply = String(message.text || "").trim();
        if (!humanReply) return next();

        try {
            const decision = await classifyHumanReply(
                state.candidateLastMessage || "",
                humanReply,
                state.candidateProposedSlot
            );

            if (decision.action === "confirm_candidate_time") {
                if (!state.candidateProposedSlot) {
                    await ctx.reply("Не вижу конкретного слота от кандидата. Нужен новый ответ с указанием времени.", {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }
                const validationError = validateSlot(state.candidateProposedSlot);
                if (validationError) {
                    await ctx.reply(`Нельзя подтвердить слот кандидата: ${validationError}`, {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }
                const available = await isInterviewSlotAvailable(state.candidateProposedSlot);
                if (!available) {
                    await ctx.reply("Этот слот уже занят. Предложите кандидату другое время reply-сообщением.", {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }

                await scheduleConfirmedSlot(bot, state, state.candidateProposedSlot);
                await sendCandidateMessage(state.messagesUrl, decision.candidate_reply || "Да, это время нам подходит. Ждём вас на собеседовании.");
                await ctx.reply("Слот подтверждён, встреча записана, кандидату отправлено подтверждение.", {
                    reply_parameters: { message_id: message.message_id },
                });
                return;
            }

            if (decision.action === "offer_new_time") {
                const slot = { date: decision.date, time: decision.time };
                const validationError = validateSlot(slot);
                if (validationError) {
                    await ctx.reply(`Не могу предложить этот слот кандидату: ${validationError}`, {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }
                const available = await isInterviewSlotAvailable(slot);
                if (!available) {
                    await ctx.reply("Этот слот уже занят. Предложите другой reply-сообщением.", {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }

                updateInterviewChatState(state.negotiationId, {
                    status: "waiting_candidate_confirmation",
                    employerProposedSlot: {
                        date: normalizeDate(slot.date),
                        time: normalizeTime(slot.time),
                    },
                    pendingTelegramChatId: undefined,
                    pendingTelegramThreadId: undefined,
                    pendingTelegramMessageId: undefined,
                });
                await sendCandidateMessage(state.messagesUrl, decision.candidate_reply);
                await ctx.reply("Кандидату отправлено новое предложенное время. Жду его подтверждения в HH.", {
                    reply_parameters: { message_id: message.message_id },
                });
                return;
            }

            if (decision.action === "ask_candidate" || decision.action === "reject_without_slot") {
                updateInterviewChatState(state.negotiationId, {
                    status: "waiting_candidate_time",
                    pendingTelegramChatId: undefined,
                    pendingTelegramThreadId: undefined,
                    pendingTelegramMessageId: undefined,
                    employerProposedSlot: null,
                });
                await sendCandidateMessage(state.messagesUrl, decision.candidate_reply);
                await ctx.reply("Ответ отправлен кандидату. Жду следующего сообщения от него в HH.", {
                    reply_parameters: { message_id: message.message_id },
                });
                return;
            }

            await ctx.reply("Не смог понять reply. Напишите ответ ещё раз более явно.", {
                reply_parameters: { message_id: message.message_id },
            });
        } catch (error: any) {
            console.error("[interview-chat] ошибка обработки Telegram reply:", error);
            await ctx.reply(`Ошибка обработки: ${error.message}`, {
                reply_parameters: { message_id: message.message_id },
            });
        }
    });
}
