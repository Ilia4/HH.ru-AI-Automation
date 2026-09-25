import type { Bot, Context } from "grammy";
import { askAi, parseAiJsonText } from "./ai-scorer";
import {
    appendInterviewBooking,
    bookingBelongsToCandidate,
    findInterviewBookingAtSlot,
    interviewSlotUtcMs,
    isInterviewSlotPast,
    isTimeInAllowedWindow,
    isWeekend,
    normalizeDate,
    normalizeTime,
} from "./interview-calendar";
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
import { decorate } from "./candidate-tags";
import { buildCandidateCard, candidateTelegramOptions } from "./telegram-cards";
import { getConversationMessages, sendCandidateMessage, getNegotiation, extractActions, doNegotiationAction, type HhMessage, type HhNegotiation } from "./hh-api";
import { currentHhAccountId, withHhAccount } from "../hh-auth/account-context";

export interface CandidateDecision {
    action: "propose_time" | "accept_time" | "question" | "unclear";
    date: string;
    time: string;
    reason: string;
}

export interface HumanDecision {
    action: "confirm_candidate_time" | "offer_new_time" | "ask_candidate" | "reject_without_slot";
    candidate_reply: string;
    date: string;
    time: string;
    reason: string;
}

function stateAccountId(state: InterviewChatState): string {
    if (!state.hhAccountId) throw new Error(`Не указан аккаунт HH для диалога ${state.negotiationId}`);
    return state.hhAccountId;
}

function sendStateMessage(state: InterviewChatState, text: string): Promise<void> {
    return withHhAccount(stateAccountId(state), () => sendCandidateMessage(state.messagesUrl, text));
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
        "- если ответственный задаёт обычный вопрос о том, актуальна ли вакансия, почему кандидат не пришёл, где он находится и т.п., это ask_candidate — даже если в тексте упомянуто старое время встречи",
        "- прошедшее время в описании («мы ожидали вас сегодня в 11:00») не является подтверждением или предложением слота",
        "- candidate_reply повторяет текст ответственного без изменения смысла",
    ].join("\n");
}

async function classifyCandidateMessage(message: string, pendingEmployerSlot?: InterviewSlotProposal | null): Promise<CandidateDecision> {
    try {
        const raw = await askAi(buildCandidatePrompt(message, pendingEmployerSlot));
        const parsed = parseAiJsonText(raw);
        return reconcileCandidateDecision(message, {
            action: parsed.action,
            date: String(parsed.date || "").trim(),
            time: String(parsed.time || "").trim(),
            reason: String(parsed.reason || "").trim(),
        }, pendingEmployerSlot);
    } catch (error: any) {
        // Сбой ИИ не должен терять сообщение кандидата: оно уйдёт HR как
        // нераспознанное, а не исчезнет после продвижения курсора HH-чата.
        console.warn(`[interview-chat] ИИ не разобрал время кандидата: ${error?.message || error}`);
        return { action: "unclear", date: "", time: "", reason: "AI unavailable" };
    }
}

async function classifyHumanReply(candidateMessage: string, humanReply: string, candidateSlot?: InterviewSlotProposal | null): Promise<HumanDecision> {
    const raw = await askAi(buildHumanPrompt(candidateMessage, humanReply, candidateSlot));
    const parsed = parseAiJsonText(raw);
    return reconcileHumanDecision(humanReply, {
        action: parsed.action,
        candidate_reply: String(parsed.candidate_reply || "").trim(),
        date: String(parsed.date || "").trim(),
        time: String(parsed.time || "").trim(),
        reason: String(parsed.reason || "").trim(),
    }, candidateSlot);
}

const ACCEPT_SLOT_RE = /(?:^|[\s,.;!?])(?:да|соглас(?:ны|на|ен)|договорились|подтвержда(?:ю|ем))(?=\s|[,.!]|$)|(?:время|слот)\s+подходит(?=\s|[,.!]|$)|(?:жд[её]м|записали)\s+вас(?=\s|[,.!]|$)/i;
const OFFER_SLOT_RE = /(?:удобно\s+(?:ли\s+)?(?:будет|вам)|можете|сможете|предлага(?:ю|ем)|давайте|приходите|подойти|встретиться|назначим|перенес[её]м|жд[её]м\s+вас)/i;
const CANDIDATE_ACCEPT_RE = /(?:^|[\s,.;!?])(?:да|хорошо|ладно|договорились|соглас(?:ен|на)|подтверждаю|смогу|буду|приду|подойду|подъеду|в\s+силе|подходит|устраивает|ок(?:ей)?)(?=\s|[,.!]|$)/i;
const CANDIDATE_REFUSAL_RE = /(?:не\s+смогу|не\s+могу|не\s+получится|не\s+приеду|не\s+подойду|не\s+подходит|не\s+устраивает|отмен(?:а|ить|ите)|хочу\s+перенести|можно\s+перенести|нужно\s+перенести|давайте\s+перенес|друг(?:ой|ое)\s+(?:день|время))/i;

function normalizedSlot(slot?: InterviewSlotProposal | null): InterviewSlotProposal | null {
    if (!slot?.date || !slot?.time) return null;
    const date = normalizeDate(slot.date);
    const time = normalizeTime(slot.time);
    return date && time ? { date, time } : null;
}

function sameSlot(a?: InterviewSlotProposal | null, b?: InterviewSlotProposal | null): boolean {
    const aa = normalizedSlot(a);
    const bb = normalizedSlot(b);
    return Boolean(aa && bb && aa.date === bb.date && aa.time === bb.time);
}

/** Числовой слот прямо из текста. Он надёжнее даты, которую мог додумать ИИ. */
function explicitNumericSlot(text: string, reference?: InterviewSlotProposal | null): InterviewSlotProposal | null {
    const source = String(text || "");
    // Дату без года принимаем только с точкой/слешем: «11-00» — это время,
    // и его нельзя случайно превратить в 11-й день нулевого месяца.
    const dateMatch = source.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/) ||
        source.match(/(\d{1,2})-(\d{1,2})-(\d{2,4})/);
    if (!dateMatch || dateMatch.index === undefined) return null;
    const dateStart = dateMatch.index;
    const dateEnd = dateStart + dateMatch[0].length;
    const timeMatches = [...source.matchAll(/(\d{1,2})[:.\-](\d{2})/g)]
        .filter((match) => {
            const start = match.index ?? -1;
            const end = start + match[0].length;
            return end <= dateStart || start >= dateEnd;
        })
        .map((match) => ({ match, normalized: normalizeTime(`${match[1]}:${match[2]}`) }))
        .filter((item) => Boolean(item.normalized));
    const timeMatch = timeMatches.at(-1);
    if (!timeMatch) return null;
    const referenceYear = normalizeDate(reference?.date || "").split(".")[2];
    let year = dateMatch[3] || referenceYear || String(new Date().getFullYear());
    if (year.length === 2) year = `20${year}`;
    const date = normalizeDate(`${dateMatch[1]}.${dateMatch[2]}.${year}`);
    const time = timeMatch.normalized;
    return date && time ? { date, time } : null;
}

/**
 * Не даём ИИ автоматически записать кандидата по двусмысленному «Спасибо» и
 * отличаем повтор предложенного работодателем времени от нового слота.
 */
export function reconcileCandidateDecision(
    message: string,
    decision: CandidateDecision,
    pendingEmployerSlot?: InterviewSlotProposal | null,
): CandidateDecision {
    const text = String(message || "").trim();
    const aiExtracted = decision.date && decision.time
        ? { date: decision.date, time: decision.time }
        : null;
    const textualSlot = explicitNumericSlot(text, pendingEmployerSlot);
    const extracted = textualSlot || aiExtracted;
    const repeatsEmployerSlot = sameSlot(extracted, pendingEmployerSlot);
    const refuses = CANDIDATE_REFUSAL_RE.test(text);
    const explicitlyAccepts = CANDIDATE_ACCEPT_RE.test(text) && !refuses;

    let action = decision.action;
    if (action === "accept_time") {
        if (!pendingEmployerSlot || refuses) {
            action = extracted ? "propose_time" : "unclear";
        } else if (extracted && !repeatsEmployerSlot) {
            action = "propose_time";
        } else if (!explicitlyAccepts && !repeatsEmployerSlot) {
            action = "unclear";
        }
    } else if (action === "propose_time" && pendingEmployerSlot && repeatsEmployerSlot && !refuses) {
        // «Я же согласилась на 25.08 в 11:00» — подтверждение сохранённого слота,
        // а не новое предложение, которое нужно повторно согласовывать с HR.
        action = "accept_time";
    }

    return {
        ...decision,
        action,
        date: extracted?.date || decision.date,
        time: extracted?.time || decision.time,
    };
}

/**
 * ИИ используется для понимания свободного текста, но опасные действия подтверждаем
 * явными признаками в самом reply. Это не даёт обычному вопросу HR забронировать слот.
 */
export function reconcileHumanDecision(
    humanReply: string,
    decision: HumanDecision,
    candidateSlot?: InterviewSlotProposal | null,
): HumanDecision {
    const text = String(humanReply || "").trim();
    const textualSlot = explicitNumericSlot(text, candidateSlot);
    const resolvedDecision = textualSlot
        ? { ...decision, date: textualSlot.date, time: textualSlot.time }
        : decision;
    const acceptsCandidateSlot = ACCEPT_SLOT_RE.test(text) && !text.includes("?");
    const offersNewSlot = OFFER_SLOT_RE.test(text) && Boolean(resolvedDecision.date && resolvedDecision.time);
    const extractedSlot = resolvedDecision.date && resolvedDecision.time
        ? { date: resolvedDecision.date, time: resolvedDecision.time }
        : null;
    const extractedDifferentSlot = Boolean(extractedSlot && candidateSlot && !sameSlot(extractedSlot, candidateSlot));

    let action = decision.action;
    if (action === "confirm_candidate_time" && offersNewSlot && extractedDifferentSlot) {
        // HR назвал другой слот («ждём вас 26.08»), поэтому нельзя подтверждать
        // старое время кандидата, даже если ИИ выбрал confirm_candidate_time.
        action = "offer_new_time";
    } else if (action === "confirm_candidate_time" && !acceptsCandidateSlot) {
        action = offersNewSlot ? "offer_new_time" : "ask_candidate";
    } else if (action === "offer_new_time" && !offersNewSlot) {
        action = "ask_candidate";
    }

    return {
        ...resolvedDecision,
        action,
        // В HH уходит ровно текст сотрудника: ИИ только классифицирует и извлекает слот.
        candidate_reply: text,
    };
}

const WEEKDAY_NAMES = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];

/** «19.09.2026» → «суббота» — чтобы в отказе было видно, какой день бот понял. */
function weekdayOf(date: string): string {
    const [d, m, y] = normalizeDate(date).split(".").map(Number);
    if (!d || !m || !y) return "";
    return WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()];
}

export function validateSlot(slot: InterviewSlotProposal, nowMs = Date.now()): string | null {
    const date = normalizeDate(slot.date);
    const time = normalizeTime(slot.time);
    if (!date || !time || interviewSlotUtcMs({ date, time }) === null) return "не удалось распознать корректную дату или время";
    // Называем распознанную дату: без неё непонятно, что бот понял «19.09» как сентябрь.
    if (isWeekend(date)) return `${date} — это ${weekdayOf(date)}, а собеседования назначаем только по будням. Если имелся в виду другой день, напишите дату с месяцем, например «19.08 в 13:00»`;
    if (!isTimeInAllowedWindow(time)) return `${date} ${time} — время вне интервала 10:00–17:00 по будням`;
    if (isInterviewSlotPast({ date, time }, nowMs)) return `${date} ${time} уже прошло — укажите будущее время`;
    return null;
}

async function sendToTelegram(bot: Bot, state: InterviewChatState, text: string): Promise<InterviewChatState> {
    const groupChatId = process.env.GROUP_CHAT_ID;
    if (!groupChatId) throw new Error("GROUP_CHAT_ID не задан в .env");
    const threadId = await findThreadId(bot, state.vacancyName);
    const deco = decorate(text, {
        vacancyName: state.vacancyName,
        vacancyId: state.vacancyId,
        candidateName: state.candidateName,
        resumeUrl: state.resumeUrl,
        html: true,
    });
    const opts: any = { ...candidateTelegramOptions };
    if (threadId) opts.message_thread_id = threadId;
    if (deco.keyboard) opts.reply_markup = deco.keyboard;
    const sent = await bot.api.sendMessage(groupChatId, deco.text, opts);

    // Держим последние карточки: ответить могут на любую из них, а не только на свежую.
    const history = [...(state.pendingTelegramMessageIds || []), sent.message_id].slice(-10);
    const contexts = { ...(state.pendingTelegramContexts || {}) };
    contexts[String(sent.message_id)] = {
        candidateMessage: state.candidateLastMessage || "",
        candidateProposedSlot: state.candidateProposedSlot ?? null,
        createdAt: new Date().toISOString(),
    };
    const allowedIds = new Set(history.map(String));
    for (const key of Object.keys(contexts)) if (!allowedIds.has(key)) delete contexts[key];

    return updateInterviewChatState(state.negotiationId, {
        status: "waiting_human_reply",
        pendingTelegramChatId: groupChatId,
        pendingTelegramThreadId: threadId,
        pendingTelegramMessageId: sent.message_id,
        pendingTelegramMessageIds: history,
        pendingTelegramContexts: contexts,
    });
}

async function scheduleConfirmedSlot(bot: Bot, state: InterviewChatState, slot: InterviewSlotProposal): Promise<{ alreadyBooked: boolean }> {
    const normalizedSlot = { date: normalizeDate(slot.date), time: normalizeTime(slot.time) };
    const validationError = validateSlot(normalizedSlot);
    if (validationError) throw new Error(validationError);

    const existingBooking = await findInterviewBookingAtSlot(normalizedSlot);
    const alreadyBooked = Boolean(existingBooking && bookingBelongsToCandidate(existingBooking, state.candidateName, state.resumeUrl));
    if (existingBooking && !alreadyBooked) throw new Error(`слот ${normalizedSlot.date} ${normalizedSlot.time} уже занят другим кандидатом`);

    if (!alreadyBooked) {
        await appendInterviewBooking({
            vacancyName: state.vacancyName,
            candidateFullName: state.candidateName,
            resumeUrl: state.resumeUrl,
            date: normalizedSlot.date,
            time: normalizedSlot.time,
            contactCandidate: "HH chat",
        });
    }

    // Дата/время согласованы → переводим кандидата в стадию «Собеседование» на HH
    try {
        const hh = await withHhAccount(stateAccountId(state), () => getNegotiation(state.negotiationId));
        const actions = hh ? extractActions(hh) : null;
        if (actions?.action_interview_url) {
            await withHhAccount(stateAccountId(state), () =>
                doNegotiationAction(actions.action_interview_url, actions.action_interview_method)
            );
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
        // Новый согласованный слот — новый цикл подтверждения. Старые карточки
        // и флаги от предыдущей даты не должны блокировать напоминание.
        confirmationRequestedAt: undefined,
        confirmTgMessageId: undefined,
        pendingTelegramChatId: undefined,
        pendingTelegramThreadId: undefined,
        pendingTelegramMessageId: undefined,
        pendingTelegramMessageIds: [],
        pendingTelegramContexts: {},
    });

    // Уведомляем HR в теме вакансии — чтобы назначенные встречи всегда были на виду
    try {
        const groupChatId = process.env.GROUP_CHAT_ID;
        if (groupChatId) {
            const threadId = await findThreadId(bot, state.vacancyName);
            const text = buildCandidateCard({
                header: "✅ СОБЕСЕДОВАНИЕ НАЗНАЧЕНО",
                candidateName: state.candidateName,
                vacancyName: state.vacancyName,
                stage: "Собеседование",
                fields: [{ icon: "🗓", label: "Дата и время", value: `${normalizedSlot.date} в ${normalizedSlot.time}` }],
            });
            const deco = decorate(text, {
                vacancyName: state.vacancyName,
                vacancyId: state.vacancyId,
                candidateName: state.candidateName,
                resumeUrl: state.resumeUrl,
                html: true,
            });
            await bot.api.sendMessage(groupChatId, deco.text, {
                ...candidateTelegramOptions,
                ...(threadId ? { message_thread_id: threadId } : {}),
                ...(deco.keyboard ? { reply_markup: deco.keyboard } : {}),
            });
        }
    } catch (e) {
        console.error(`[interview-chat] не смог уведомить о назначенной встрече:`, e);
    }

    return { alreadyBooked };
}

export async function registerInterviewConversation(
    vacancy: { vacancyId: string; vacancyName: string; templatesUrl?: string | null },
    candidate: HhNegotiation
): Promise<void> {
    if (!candidate.messages_url) return;
    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) return;
    const hhAccountId = currentHhAccountId();
    if (!hhAccountId) throw new Error(`Не выбран аккаунт HH для диалога ${candidate.id}`);

    const existing = getInterviewChatState(candidate.id);
    if (existing && existing.status !== "closed") return;

    const messages = await getConversationMessages(candidate.messages_url);
    const last = latestMessage(messages);
    const resumeBase = candidate.resume?.alternate_url
        || (candidate.resume?.id ? `https://hh.ru/resume/${candidate.resume.id}` : "")
        || candidate.resume?.url
        || "";
    const resumeUrl = resumeBase && !resumeBase.includes("?t=")
        ? `${resumeBase}${resumeBase.includes("?") ? "&" : "?"}t=${candidate.id}`
        : resumeBase;
    upsertInterviewChatState({
        negotiationId: candidate.id,
        hhAccountId,
        vacancyId: vacancy.vacancyId,
        vacancyName: vacancy.vacancyName,
        spreadsheetId,
        candidateName: [candidate.resume?.last_name, candidate.resume?.first_name, candidate.resume?.middle_name].filter(Boolean).join(" ") || candidate.resume?.title || "Candidate",
        resumeUrl,
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
        await sendStateMessage(updated, "Отлично, договорились. Мы записали вас на собеседование.");
        return;
    }

    const parsedProposal = candidateDecision.action === "propose_time" && candidateDecision.date && candidateDecision.time
        ? { date: candidateDecision.date, time: candidateDecision.time }
        : null;
    const proposalAlreadyPast = Boolean(parsedProposal && isInterviewSlotPast(parsedProposal));
    const previousProposal = state.candidateProposedSlot && !isInterviewSlotPast(state.candidateProposedSlot)
        ? state.candidateProposedSlot
        : null;
    const proposal = parsedProposal
        ? (proposalAlreadyPast ? null : parsedProposal)
        : previousProposal;

    const withProposal = updateInterviewChatState(state.negotiationId, {
        // Если в новом сообщении времени нет («всё в силе?»), держимся за ранее
        // названный слот — иначе подтвердить его уже не получится.
        candidateProposedSlot: proposal,
        employerProposedSlot: updated.status === "waiting_candidate_confirmation" ? updated.employerProposedSlot : null,
    });

    const slotField = parsedProposal && !proposalAlreadyPast
        ? [{ icon: "🕐", label: "Распознанный слот", value: `${parsedProposal.date} в ${parsedProposal.time}` }]
        : previousProposal
            ? [{ icon: "🕐", label: "Ранее предложенный слот", value: `${previousProposal.date} в ${previousProposal.time}` }]
            : [];
    const details = parsedProposal && proposalAlreadyPast
        ? [`⚠️ Кандидат назвал уже прошедшее время: ${parsedProposal.date} ${parsedProposal.time}. Его нельзя подтвердить.`]
        : !parsedProposal && !previousProposal
            ? ["Точный слот из сообщения кандидата не распознан."]
            : [];
    const telegramText = buildCandidateCard({
        header: slotField.length ? "🗓 КАНДИДАТ ПРЕДЛОЖИЛ ВРЕМЯ" : "🗓 НУЖНО УТОЧНИТЬ ВРЕМЯ",
        candidateName: updated.candidateName,
        vacancyName: updated.vacancyName,
        stage: "Собеседование",
        fields: slotField,
        quote: text || "(пустое сообщение)",
        details,
        action: slotField.length
            ? "Ответьте reply: подтвердите время, предложите другое или задайте уточняющий вопрос."
            : "Ответьте reply и предложите конкретный свободный слот.",
    });

    await sendToTelegram(bot, withProposal, telegramText);
}

export async function processInterviewChatConversations(bot: Bot): Promise<void> {
    const states = listActiveInterviewChatStates();
    for (const state of states) {
        if (state.status === "waiting_human_reply") continue;

        try {
            const messages = await withHhAccount(stateAccountId(state), () =>
                getConversationMessages(state.messagesUrl)
            );
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
            const cardContext = state.pendingTelegramContexts?.[String(message.reply_to_message.message_id)];
            const candidateMessage = cardContext?.candidateMessage ?? state.candidateLastMessage ?? "";
            const candidateSlot = cardContext?.candidateProposedSlot ?? state.candidateProposedSlot;
            const decision = await classifyHumanReply(
                candidateMessage,
                humanReply,
                candidateSlot
            );

            if (decision.action === "confirm_candidate_time") {
                if (!candidateSlot) {
                    await ctx.reply("Не вижу конкретного слота от кандидата. Нужен новый ответ с указанием времени.", {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }
                const validationError = validateSlot(candidateSlot);
                if (validationError) {
                    await ctx.reply(`Нельзя подтвердить слот кандидата: ${validationError}`, {
                        reply_parameters: { message_id: message.message_id },
                    });
                    return;
                }
                const scheduled = await scheduleConfirmedSlot(bot, state, candidateSlot);
                await sendStateMessage(state, decision.candidate_reply || "Да, это время нам подходит. Ждём вас на собеседовании.");
                await ctx.reply(scheduled.alreadyBooked
                    ? "Этот кандидат уже записан на данный слот. Состояние синхронизировано, ответ отправлен кандидату."
                    : "Слот подтверждён, встреча записана, кандидату отправлено подтверждение.", {
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
                const existingBooking = await findInterviewBookingAtSlot(slot);
                if (existingBooking && !bookingBelongsToCandidate(existingBooking, state.candidateName, state.resumeUrl)) {
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
                    candidateProposedSlot: null,
                    pendingTelegramChatId: undefined,
                    pendingTelegramThreadId: undefined,
                    pendingTelegramMessageId: undefined,
                    pendingTelegramMessageIds: [],
                    pendingTelegramContexts: {},
                });
                await sendStateMessage(state, decision.candidate_reply);
                await ctx.reply("Кандидату отправлено новое предложенное время. Жду его подтверждения в HH.", {
                    reply_parameters: { message_id: message.message_id },
                });
                return;
            }

            if (decision.action === "ask_candidate" || decision.action === "reject_without_slot") {
                const keepEmployerOffer = decision.action === "ask_candidate" && Boolean(state.employerProposedSlot);
                updateInterviewChatState(state.negotiationId, {
                    status: keepEmployerOffer ? "waiting_candidate_confirmation" : "waiting_candidate_time",
                    pendingTelegramChatId: undefined,
                    pendingTelegramThreadId: undefined,
                    pendingTelegramMessageId: undefined,
                    pendingTelegramMessageIds: [],
                    pendingTelegramContexts: {},
                    employerProposedSlot: keepEmployerOffer ? state.employerProposedSlot : null,
                    candidateProposedSlot: candidateSlot && !isInterviewSlotPast(candidateSlot) ? candidateSlot : null,
                });
                await sendStateMessage(state, decision.candidate_reply);
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
