import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sendCandidateMessage } from "./hh-api";
import { listTrackedVacancies } from "../chat-sim/vacancies";
import { isRuntimeVacancyStopped } from "./vacancy-activity";
import { findThreadId } from "./topics.store";
import { askAi, parseAiJsonText } from "./ai-scorer";
import {
    getInterviewChatState,
    updateInterviewChatState,
    listOpenInterviewChatStates,
    findInterviewChatByCancelPrompt,
    findInterviewChatByForwardedMessage,
    type InterviewChatState,
} from "./interview-chat.store";
import { handleSchedulingMessage } from "./interview-chat";
import { interviewSlotUtcMs, isInterviewSlotPast, removeInterviewBooking } from "./interview-calendar";
import { decorate } from "./candidate-tags";
import { buildCandidateCard, candidateTelegramOptions, escapeTelegramHtml } from "./telegram-cards";
import { withHhAccount } from "../hh-auth/account-context";

function stateAccountId(state: InterviewChatState): string {
    if (!state.hhAccountId) throw new Error(`Не указан аккаунт HH для диалога ${state.negotiationId}`);
    return state.hhAccountId;
}

// Статусы, при которых бот НЕ ведёт Q&A, а работает по сценарию подтверждения собеседования.
export const CONFIRM_STATUSES = new Set<string>([
    "scheduled",
    "confirm_requested",
    "awaiting_candidate_confirm",
    "awaiting_hr_cancel_text",
    "confirmed",
    "completed",
]);

function completeMeetingState(state: InterviewChatState): InterviewChatState {
    return updateInterviewChatState(state.negotiationId, {
        status: "completed",
        confirmationRequestedAt: undefined,
        confirmTgMessageId: undefined,
        cancelPromptTgChatId: undefined,
        cancelPromptTgMessageId: undefined,
    });
}

export function shouldCompleteMeeting(
    status: InterviewChatState["status"],
    slot: { date: string; time: string } | null,
    nowMs = Date.now(),
): boolean {
    return status !== "completed" && Boolean(slot && CONFIRM_STATUSES.has(status) && isInterviewSlotPast(slot, nowMs));
}

/**
 * Отправка в тему вакансии.
 * `state` добавляет к сообщению метку кандидата (#Фамилия_Имя) и, изредка,
 * кнопку в панель. Если у сообщения уже свои кнопки (подтвердить/отменить),
 * кнопку панели не подставляем — она бы их заменила.
 */
async function postToTopic(
    bot: Bot,
    vacancyName: string,
    text: string,
    keyboard?: InlineKeyboard,
    state?: InterviewChatState,
    html = false,
) {
    const g = process.env.GROUP_CHAT_ID;
    if (!g) { console.warn("[confirm] GROUP_CHAT_ID не задан"); return null; }
    const threadId = await findThreadId(bot, vacancyName);
    const opts: any = { ...candidateTelegramOptions };
    if (threadId) opts.message_thread_id = threadId;

    let body = text;
    if (state) {
        const deco = decorate(text, {
            vacancyName: state.vacancyName,
            vacancyId: state.vacancyId,
            candidateName: state.candidateName,
            resumeUrl: state.resumeUrl,
            html,
        });
        body = deco.text;
        if (!keyboard && deco.keyboard) opts.reply_markup = deco.keyboard;
    }
    if (!state && !html) body = escapeTelegramHtml(text);
    if (keyboard) opts.reply_markup = keyboard;
    return bot.api.sendMessage(g, body, opts);
}

/** Запрос подтверждения в тему вакансии (2 кнопки) */
export async function postConfirmationRequest(bot: Bot, state: InterviewChatState, reason: "scheduled" | "candidate") {
    const slot = state.scheduledSlot;
    const when = slot?.date && slot?.time ? `${slot.date} в ${slot.time}` : "время уточняется";
    const question = candidateConfirmationQuestion(state.candidateName, state.scheduledSlot ?? null);
    const text = buildCandidateCard({
        header: "⏰ НУЖНО РЕШЕНИЕ ПО ВСТРЕЧЕ",
        candidateName: state.candidateName,
        vacancyName: state.vacancyName,
        stage: "Собеседование",
        fields: [{ icon: "🗓", label: "Дата и время", value: when }],
        quoteLabel: "Сообщение, которое получит кандидат",
        quote: question,
        details: reason === "candidate" ? ["Кандидат снова написал в чат — его сообщение находится выше."] : undefined,
        action: "Отправьте вопрос кандидату или отмените встречу кнопкой ниже.",
    });
    const kb = new InlineKeyboard()
        .text("📨 Спросить кандидата", `icf:${state.negotiationId}`)
        .text("❌ Отменить встречу", `icx:${state.negotiationId}`);
    const sent = await postToTopic(bot, state.vacancyName, text, kb, state, true);
    updateInterviewChatState(state.negotiationId, {
        status: "confirm_requested",
        confirmationRequestedAt: new Date().toISOString(),
        confirmTgMessageId: sent?.message_id,
    });
}

function slotParts(slot: { date: string; time: string } | null): { day: string; month: string; year: string; hour: string; minute: string } | null {
    if (!slot?.date || !slot?.time) return null;
    const dm = String(slot.date).trim().match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/)
        || String(slot.date).trim().match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
    const tm = String(slot.time).trim().match(/^(\d{1,2})[:.\-](\d{2})$/);
    if (!dm || !tm) return null;
    const iso = dm[1].length === 4;
    return {
        day: String(Number(iso ? dm[3] : dm[1])),
        month: String(Number(dm[2])),
        year: iso ? dm[1] : dm[3],
        hour: String(Number(tm[1])),
        minute: tm[2],
    };
}

const MONTHS_GENITIVE = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function moscowDateKey(nowMs: number): string {
    return new Date(nowMs + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDaysToKey(key: string, days: number): string {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function candidateFirstName(fullName: string): string {
    const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
    return parts[1] || parts[0] || "Здравствуйте";
}

/** Точный текст вопроса кандидату: дата и время берутся только из сохранённого слота. */
export function candidateConfirmationQuestion(
    candidateName: string,
    slot: { date: string; time: string } | null,
    nowMs = Date.now(),
): string {
    const firstName = candidateFirstName(candidateName);
    const parts = slotParts(slot);
    if (!parts || !slot) {
        return `${firstName}, здравствуйте! Подтвердите, пожалуйста, что сможете подойти на назначенное собеседование.`;
    }
    const dateKey = `${parts.year}-${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")}`;
    const today = moscowDateKey(nowMs);
    const dateText = dateKey === today
        ? `сегодня, ${parts.day} ${MONTHS_GENITIVE[Number(parts.month) - 1]}`
        : dateKey === addDaysToKey(today, 1)
            ? `завтра, ${parts.day} ${MONTHS_GENITIVE[Number(parts.month) - 1]}`
            : `${parts.day} ${MONTHS_GENITIVE[Number(parts.month) - 1]} ${parts.year} года`;
    const time = `${parts.hour.padStart(2, "0")}:${parts.minute}`;
    return `${firstName}, здравствуйте! Напоминаем, что ${dateText}, ждём вас на собеседование в ${time}. Подтвердите, пожалуйста, что сможете подойти.`;
}

/**
 * Кандидат иногда отвечает «я же перенесла встречу на 25.08 в 11:00».
 * Это подтверждение уже назначенного слота, а не новая просьба о переносе.
 * Детерминированная проверка защищает бронь от ошибочной AI-классификации.
 */
export function repeatsScheduledSlotWithoutCancellation(
    text: string,
    slot: { date: string; time: string } | null,
): boolean {
    const parts = slotParts(slot);
    if (!parts) return false;
    const normalized = String(text || "").toLowerCase().replace(/ё/g, "е");
    const refusal = /(?:не\s+смогу|не\s+могу|не\s+получится|не\s+приеду|отмен(?:а|ить|ите)|хочу\s+перенести|можно\s+перенести|нужно\s+перенести|давайте\s+перенес|на\s+друг(?:ой|ое)\s+(?:день|время)|жду\s+нов(?:ое|ого)\s+врем)/i.test(normalized);
    if (refusal) return false;

    const dateRe = new RegExp(`(?:^|\\D)0?${parts.day}[.\\-/]0?${parts.month}(?:[.\\-/](?:${parts.year}|${parts.year.slice(-2)}))?(?:\\D|$)`);
    const timeRe = new RegExp(`(?:^|\\D)0?${parts.hour}(?:[:.\\-]${parts.minute}|\\s*(?:ч(?:ас(?:а|ов)?)?|часов))(?:\\D|$)`);
    return dateRe.test(normalized) && timeRe.test(normalized);
}

export function isConfirmationWindowOpen(
    slot: { date: string; time: string } | null,
    nowMs = Date.now(),
): boolean {
    if (!slot) return false;
    const target = interviewSlotUtcMs(slot);
    if (target === null) return false;
    const twoHours = 2 * 60 * 60 * 1000;
    return nowMs >= target - twoHours && nowMs < target;
}

async function classifyConfirm(
    text: string,
    slot: { date: string; time: string } | null,
): Promise<"confirmed" | "reschedule" | "unclear"> {
    // Частые ответы вроде «уже еду» не должны зависеть от доступности/решения ИИ.
    const explicit = reconcileScheduledMessageDecision(text, "other", slot);
    if (explicit !== "other") return explicit;
    const when = slot?.date && slot?.time ? `${slot.date} в ${slot.time}` : "назначенное время";
    const prompt = [
        `Кандидату задали вопрос: «Встреча ${when} остаётся в силе?»`,
        "Классифицируй его ответ. Верни только JSON: {\"result\":\"confirmed|reschedule|unclear\"}",
        "confirmed — подтверждает, что придёт / всё в силе.",
        "Если кандидат повторяет ту же назначенную дату и время («я же перенесла на эту дату»), это confirmed.",
        "reschedule — не сможет, просит перенести/отменить, предлагает другое время.",
        "unclear — понять нельзя.",
        "",
        `Ответ кандидата: ${text}`,
    ].join("\n");
    try {
        const r = parseAiJsonText(await askAi(prompt));
        const guarded = reconcileScheduledMessageDecision(
            text,
            r?.result === "confirmed" ? "confirmed" : r?.result === "reschedule" ? "reschedule" : "other",
            slot,
        );
        return guarded === "other" ? "unclear" : guarded;
    } catch {
        return "unclear";
    }
}

const EXPLICIT_RESCHEDULE_RE = /(?:не\s+смогу|не\s+могу|не\s+получится|не\s+успею|не\s+приеду|не\s+приду|не\s+подойду|не\s+еду|не\s+буду|отмен(?:а|ить|ите)|перен(?:ест|ос|ес)|друг(?:ой|ое)\s+(?:день|время)|вакансия\s+(?:уже\s+)?не\s+актуальна|можно.{0,50}(?:завтра|послезавтра|\d{1,2}[.\-/]\d{1,2}|\d{1,2}[:.\-]\d{2}))/i;
const EXPLICIT_CONFIRM_RE = /(?:^|[\s,.;!?])(?:да|хорошо|договорились|подтверждаю|смогу|буду|приду|подойду|подъеду|в\s+силе|подходит|устраивает|ок(?:ей)?)(?=\s|[,.!]|$)/i;
const ARRIVAL_CONFIRM_RE = /(?:уже\s+)?(?:еду|в\s+пути|выехал(?:а)?|подъезжаю|добираюсь|почти\s+приехал(?:а)?)|(?:опоздаю|задержусь|могу.{0,30}задержаться)(?:\s+(?:примерно\s+)?(?:на\s+)?\d+\s*мин(?:ут[уы]?)?)?/i;

/** ИИ понимает смысл, но отменять бронь ему разрешают только явные слова кандидата. */
export function reconcileScheduledMessageDecision(
    text: string,
    aiDecision: "reschedule" | "confirmed" | "other",
    slot: { date: string; time: string } | null,
): "reschedule" | "confirmed" | "other" {
    if (repeatsScheduledSlotWithoutCancellation(text, slot)) return "confirmed";
    // Явный отказ важнее слов «буду/еду» в той же фразе.
    if (EXPLICIT_RESCHEDULE_RE.test(text)) return "reschedule";
    if (EXPLICIT_CONFIRM_RE.test(text) || ARRIVAL_CONFIRM_RE.test(text)) return "confirmed";
    if (aiDecision === "reschedule") return EXPLICIT_RESCHEDULE_RE.test(text) ? "reschedule" : "other";
    if (aiDecision === "confirmed") return (EXPLICIT_CONFIRM_RE.test(text) || ARRIVAL_CONFIRM_RE.test(text)) ? "confirmed" : "other";
    return "other";
}

/**
 * Кандидат написал, когда встреча уже стоит в календаре.
 * Отличаем три вещи: просьбу перенести/отменить, подтверждение и обычный вопрос.
 * Отдельный разбор от classifyConfirm: там кандидат отвечает на прямой вопрос
 * «всё в силе?», а здесь он пишет сам, без повода.
 */
async function classifyScheduledMessage(
    text: string,
    slot: { date: string; time: string } | null,
): Promise<"reschedule" | "confirmed" | "other"> {
    const explicit = reconcileScheduledMessageDecision(text, "other", slot);
    if (explicit !== "other") return explicit;
    const when = slot?.date ? `${slot.date} в ${slot.time}` : "назначенное время";
    const prompt = [
        `Кандидату назначено собеседование на ${when}. Он прислал сообщение.`,
        "Классифицируй. Верни только JSON: {\"result\":\"reschedule|confirmed|other\"}",
        "reschedule — не сможет прийти, просит перенести или отменить, предлагает другую дату/время.",
        "confirmed — подтверждает, что придёт в назначенное время.",
        "other — вопрос или всё остальное (как добраться, что взять, уточнения).",
        "",
        `Сообщение кандидата: ${text}`,
    ].join("\n");
    try {
        const r = parseAiJsonText(await askAi(prompt));
        const aiDecision = r?.result === "reschedule" ? "reschedule" : r?.result === "confirmed" ? "confirmed" : "other";
        return reconcileScheduledMessageDecision(text, aiDecision, slot);
    } catch {
        return "other";
    }
}

/**
 * Снять бронь в календаре при переносе или отмене.
 * Без этого слот остаётся занятым фантомной встречей: бот не предложит его
 * другому кандидату, а в расписании висит несуществующая запись.
 */
async function releaseSlot(state: InterviewChatState): Promise<string> {
    const slot = state.scheduledSlot;
    if (!slot?.date || !slot?.time) return "";
    try {
        const r = await removeInterviewBooking(slot, state.candidateName);
        return r.removed ? ` Бронь ${slot.date} ${slot.time} снята с календаря.` : "";
    } catch (e: any) {
        console.warn(`[confirm] не смог снять бронь ${state.negotiationId}: ${e.message}`);
        return ` ⚠️ Бронь ${slot.date} ${slot.time} снять не удалось — уберите из календаря вручную.`;
    }
}

/** Сообщение кандидата в стадии «Собеседование» / сценарии подтверждения */
export async function handleConfirmationCandidateMessage(bot: Bot, state: InterviewChatState, text: string) {
    // После наступления времени встречи старый слот больше нельзя подтверждать,
    // отменять или повторно «занимать». Обычное сообщение пересылаем HR. Если
    // кандидат явно просит новое время, начинаем новый цикл без удаления истории.
    if (shouldCompleteMeeting(state.status, state.scheduledSlot ?? null)) {
        state = completeMeetingState(state);
    }
    if (state.status === "completed") {
        const decision = await classifyScheduledMessage(text, state.scheduledSlot ?? null);
        if (decision === "reschedule") {
            const fresh = updateInterviewChatState(state.negotiationId, {
                status: "waiting_candidate_time",
                scheduledSlot: null,
                candidateProposedSlot: null,
                employerProposedSlot: null,
                forwardedTgMessageIds: [],
            });
            await handleSchedulingMessage(bot, fresh, text);
            return;
        }
        // Не пытаемся классифицировать упомянутое прошлое время как новый слот.
        // Ниже сообщение будет переслано HR, а reply уйдёт кандидату как обычный текст.
    }

    // Ответ кандидата на вопрос о конкретной назначенной дате и времени.
    if (state.status === "awaiting_candidate_confirm") {
        const decision = await classifyConfirm(text, state.scheduledSlot ?? null);
        if (decision === "confirmed") {
            updateInterviewChatState(state.negotiationId, { status: "confirmed" });
            await postToTopic(bot, state.vacancyName, buildCandidateCard({
                header: "✅ КАНДИДАТ ПОДТВЕРДИЛ ВСТРЕЧУ",
                candidateName: state.candidateName,
                vacancyName: state.vacancyName,
                stage: "Собеседование",
                quoteLabel: "Ответ кандидата",
                quote: text,
            }), undefined, state, true);
        } else if (decision === "reschedule") {
            const released = await releaseSlot(state);
            updateInterviewChatState(state.negotiationId, { status: "waiting_candidate_time", scheduledSlot: null });
            await postToTopic(bot, state.vacancyName, buildCandidateCard({
                header: "♻️ КАНДИДАТ ПРОСИТ ПЕРЕНОС",
                candidateName: state.candidateName,
                vacancyName: state.vacancyName,
                stage: "Собеседование",
                quote: text,
                details: released.trim() ? [released.trim()] : undefined,
                action: "Согласуйте с кандидатом новое точное время reply-сообщением.",
            }), undefined, state, true);
            const fresh = getInterviewChatState(state.negotiationId);
            if (fresh) await handleSchedulingMessage(bot, fresh, text);
        } else {
            await postToTopic(bot, state.vacancyName, buildCandidateCard({
                header: "❓ ОТВЕТ НЕ УДАЛОСЬ ПОНЯТЬ",
                candidateName: state.candidateName,
                vacancyName: state.vacancyName,
                stage: "Собеседование",
                quoteLabel: "Ответ кандидата",
                quote: text,
                action: "Проверьте сообщение и ответьте кандидату вручную.",
            }), undefined, state, true);
        }
        return;
    }

    // Встреча уже в календаре, а кандидат пишет сам: он может отменять или переносить.
    // Раньше такое просто пересылалось, бронь оставалась, и бот вдогонку спрашивал
    // «всё в силе?» — хотя кандидат только что написал, что не придёт.
    if (state.status === "scheduled" || state.status === "confirmed" || state.status === "confirm_requested") {
        const decision = await classifyScheduledMessage(text, state.scheduledSlot ?? null);
        if (decision === "reschedule") {
            const released = await releaseSlot(state);
            updateInterviewChatState(state.negotiationId, { status: "waiting_candidate_time", scheduledSlot: null });
            await postToTopic(
                bot,
                state.vacancyName,
                buildCandidateCard({
                    header: "♻️ ПЕРЕНОС НАЗНАЧЕННОЙ ВСТРЕЧИ",
                    candidateName: state.candidateName,
                    vacancyName: state.vacancyName,
                    stage: "Собеседование",
                    quote: text,
                    details: released.trim() ? [released.trim()] : undefined,
                    action: "Ответьте reply: подтвердите новый слот или предложите другое время.",
                }),
                undefined,
                state,
                true,
            );
            const fresh = getInterviewChatState(state.negotiationId);
            if (fresh) await handleSchedulingMessage(bot, fresh, text);
            return;
        }
        if (decision === "confirmed" && state.status !== "confirmed") {
            updateInterviewChatState(state.negotiationId, { status: "confirmed" });
            await postToTopic(bot, state.vacancyName, buildCandidateCard({
                header: "✅ КАНДИДАТ ПОДТВЕРДИЛ ВСТРЕЧУ",
                candidateName: state.candidateName,
                vacancyName: state.vacancyName,
                stage: "Собеседование",
                quoteLabel: "Ответ кандидата",
                quote: text,
            }), undefined, state, true);
            return;
        }
    }

    // Остальные стадии подтверждения — просто пересылаем сообщение кандидата в тему
    const fwd = await postToTopic(bot, state.vacancyName, buildCandidateCard({
        header: "💬 НОВОЕ СООБЩЕНИЕ КАНДИДАТА",
        candidateName: state.candidateName,
        vacancyName: state.vacancyName,
        stage: "Собеседование",
        quote: text,
        action: "При необходимости ответьте reply — ответ уйдёт кандидату в HH.",
    }), undefined, state, true);
    if (fwd?.message_id) {
        const prev = getInterviewChatState(state.negotiationId)?.forwardedTgMessageIds ?? [];
        updateInterviewChatState(state.negotiationId, {
            forwardTgChatId: String(process.env.GROUP_CHAT_ID || ""),
            forwardedTgMessageIds: [...prev, fwd.message_id].slice(-30),
        });
    }

    // Обычное сообщение («Спасибо») не должно запускать подтверждение за несколько
    // дней до встречи. Реактивно спрашиваем только внутри того же двухчасового окна,
    // что и плановый sweep; в остальное время сообщение просто пересылается HR.
    if (state.status === "scheduled" && !state.confirmationRequestedAt && isConfirmationWindowOpen(state.scheduledSlot ?? null)) {
        await postConfirmationRequest(bot, state, "candidate");
    }
}

/** За ~2 часа до собеседования — один раз отправляем запрос подтверждения в тему */
export async function runInterviewConfirmSweep(bot: Bot) {
    const now = Date.now();
    const activeVacancyIds = new Set((await listTrackedVacancies()).map((v) => v.vacancyId));
    for (const st of listOpenInterviewChatStates()) {
        if (!activeVacancyIds.has(st.vacancyId) || isRuntimeVacancyStopped(st.vacancyId)) continue;
        if (shouldCompleteMeeting(st.status, st.scheduledSlot ?? null, now)) {
            completeMeetingState(st);
            continue;
        }
        if (st.status !== "scheduled") continue;
        if (st.confirmationRequestedAt) continue;
        const slot = st.scheduledSlot;
        if (!slot?.date || !slot?.time) continue;
        if (isConfirmationWindowOpen(slot, now)) {
            try { await postConfirmationRequest(bot, st, "scheduled"); }
            catch (e) { console.error(`[confirm] ошибка запроса подтверждения ${st.negotiationId}:`, e); }
        }
    }
}

/** Кнопки Подтвердить/Отменить + reply на отмену */
export function registerConfirmHandlers(bot: Bot<Context>) {
    bot.callbackQuery(/^icf:(.+)$/, async (ctx) => {
        const negId = ctx.match![1];
        const st = getInterviewChatState(negId);
        if (!st) { await ctx.answerCallbackQuery("Диалог не найден"); return; }
        try {
            if (st.status !== "confirm_requested" || st.confirmTgMessageId !== ctx.callbackQuery.message?.message_id) {
                await ctx.answerCallbackQuery("Эта карточка уже устарела");
                try { await ctx.editMessageReplyMarkup(); } catch {}
                return;
            }
            const slot = st.scheduledSlot;
            if (!slot?.date || !slot?.time || !isConfirmationWindowOpen(slot)) {
                await ctx.answerCallbackQuery("Встреча уже прошла или карточка неактуальна");
                try { await ctx.editMessageReplyMarkup(); } catch {}
                return;
            }
            const question = candidateConfirmationQuestion(st.candidateName, slot);
            await withHhAccount(stateAccountId(st), () =>
                sendCandidateMessage(st.messagesUrl, question)
            );
            updateInterviewChatState(negId, { status: "awaiting_candidate_confirm" });
            await ctx.answerCallbackQuery("Кандидату отправлен вопрос");
            try { await ctx.editMessageReplyMarkup(); } catch {}
            await ctx.reply(`Отправил ${st.candidateName} сообщение:\n\n«${question}»\n\nЖду ответ в HH.`);
        } catch (e: any) {
            await ctx.answerCallbackQuery("Ошибка: " + e.message);
        }
    });

    bot.callbackQuery(/^icx:(.+)$/, async (ctx) => {
        const negId = ctx.match![1];
        const st = getInterviewChatState(negId);
        if (!st) { await ctx.answerCallbackQuery("Диалог не найден"); return; }
        if (st.status !== "confirm_requested" || st.confirmTgMessageId !== ctx.callbackQuery.message?.message_id) {
            await ctx.answerCallbackQuery("Эта карточка уже устарела");
            try { await ctx.editMessageReplyMarkup(); } catch {}
            return;
        }
        if (!st.scheduledSlot || !isConfirmationWindowOpen(st.scheduledSlot)) {
            await ctx.answerCallbackQuery("Встреча уже прошла или карточка неактуальна");
            try { await ctx.editMessageReplyMarkup(); } catch {}
            return;
        }
        await ctx.answerCallbackQuery();
        try { await ctx.editMessageReplyMarkup(); } catch {}
        const cancelText = buildCandidateCard({
            header: "❌ ОТМЕНА ИЛИ ПЕРЕНОС ВСТРЕЧИ",
            candidateName: st.candidateName,
            vacancyName: st.vacancyName,
            stage: "Собеседование",
            fields: st.scheduledSlot
                ? [{ icon: "🗓", label: "Текущая встреча", value: `${st.scheduledSlot.date} в ${st.scheduledSlot.time}` }]
                : undefined,
            action: "Ответьте reply на это сообщение — текст уйдёт кандидату в HH.",
        });
        const cancelDeco = decorate(cancelText, {
            vacancyName: st.vacancyName,
            vacancyId: st.vacancyId,
            candidateName: st.candidateName,
            resumeUrl: st.resumeUrl,
            html: true,
        });
        const prompt = await ctx.reply(cancelDeco.text, {
            ...candidateTelegramOptions,
            ...(cancelDeco.keyboard ? { reply_markup: cancelDeco.keyboard } : {}),
        });
        updateInterviewChatState(negId, {
            status: "awaiting_hr_cancel_text",
            cancelPromptTgChatId: String(ctx.chat!.id),
            cancelPromptTgMessageId: prompt.message_id,
        });
    });

    bot.on("message:text", async (ctx, next) => {
        const groupId = process.env.GROUP_CHAT_ID;
        if (!groupId || String(ctx.chat.id) !== groupId) return next();
        if (!ctx.message.reply_to_message) return next();
        const replyId = ctx.message.reply_to_message.message_id;
        const text = String(ctx.message.text || "").trim();
        if (!text) return next();

        // 1) reply на карточку отмены встречи
        const cancelSt = findInterviewChatByCancelPrompt(String(ctx.chat.id), replyId);
        if (cancelSt) {
            try {
                await withHhAccount(stateAccountId(cancelSt), () =>
                    sendCandidateMessage(cancelSt.messagesUrl, text)
                );
                // Слот освобождаем до сброса состояния — потом дата встречи уже неизвестна.
                const released = await releaseSlot(cancelSt);
                updateInterviewChatState(cancelSt.negotiationId, {
                    status: "waiting_candidate_time",
                    scheduledSlot: null,
                    cancelPromptTgChatId: undefined,
                    cancelPromptTgMessageId: undefined,
                });
                await ctx.reply(`Отправил кандидату.${released} Дальше согласуем перенос/отмену через чат.`, { reply_parameters: { message_id: ctx.message.message_id } });
            } catch (e: any) {
                await ctx.reply("Не смог отправить кандидату: " + e.message, { reply_parameters: { message_id: ctx.message.message_id } });
            }
            return;
        }

        // 2) reply на пересланное сообщение кандидата (💬) — доставить текст кандидату
        const fwdSt = findInterviewChatByForwardedMessage(String(ctx.chat.id), replyId);
        if (fwdSt) {
            try {
                await withHhAccount(stateAccountId(fwdSt), () =>
                    sendCandidateMessage(fwdSt.messagesUrl, text)
                );
                await ctx.reply("Отправил кандидату в HH.", { reply_parameters: { message_id: ctx.message.message_id } });
            } catch (e: any) {
                await ctx.reply("Не смог отправить кандидату: " + e.message, { reply_parameters: { message_id: ctx.message.message_id } });
            }
            return;
        }

        return next();
    });
}
