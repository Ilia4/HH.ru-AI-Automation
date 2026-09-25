import type { Bot, Context } from "grammy";
import { listTrackedVacancies, extractSpreadsheetId, readVacancyQa, appendVacancyQa } from "../chat-sim/vacancies";
import { decideCandidateAnswer } from "../chat-sim/ai-router";
import { askAi, parseAiJsonText } from "./ai-scorer";
import {
    getNewResponses,
    getConsiderResponses,
    getPhoneInterviewResponses,
    getConversationMessages,
    sendCandidateMessage,
    type HhMessage,
    type HhNegotiation,
} from "./hh-api";
import { findThreadId } from "./topics.store";
import { getInterviewChatState, listOpenInterviewChatStates } from "./interview-chat.store";
import { CONFIRM_STATUSES, handleConfirmationCandidateMessage } from "./interview-confirm";
import { handleSchedulingMessage } from "./interview-chat";
import { getCursor, setCursor, createPendingQa, findPendingQaByTgMessage, resolvePendingQa } from "./chat-router.store";
import { withHhAccount } from "../hh-auth/account-context";
import { isVacancyArchived, vacancyLiveOverride } from "./archived-notify";
import { recordCandidateAnswer } from "./candidate-answers";
import { decorate } from "./candidate-tags";
import { buildCandidateCard, candidateTelegramOptions, type CandidateStage } from "./telegram-cards";
import { beginVacancyRun, canContinueVacancyRun, isRuntimeVacancyStopped } from "./vacancy-activity";

// По умолчанию dry-run: ничего не уходит кандидатам, только логи. Боевой режим — CHAT_ROUTER_DRY_RUN=false.
const DRY = process.env.CHAT_ROUTER_DRY_RUN !== "false";
// Отвечать/пересылать сообщения кандидатов в стадии «Отклик» (не только прошедших анкету).
const RESPONSE_STAGE = process.env.CHAT_ROUTER_RESPONSE_STAGE === "true";

interface EngagedChat {
    negotiationId: string;
    vacancyId: string;
    messagesUrl: string;
    vacancyName: string;
    spreadsheetId: string;
    hasSchedulingState: boolean;
    isResponseStage: boolean;
    candidateName: string;
    hhAccountId: string;
    candidateStage: CandidateStage;
    /** ссылка на резюме с ?t=<id отклика> — по ней узнаётся кандидат в листе ответов */
    resumeUrl?: string;
}

/** Ссылка на резюме с id отклика — в таком виде её ждут все листы вакансии. */
function resumeLinkOf(n: HhNegotiation): string {
    const base = n.resume?.alternate_url || "";
    if (!base) return "";
    return base.includes("?t=") ? base : `${base}?t=${n.id}`;
}

function candName(n: HhNegotiation): string {
    return [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name].filter(Boolean).join(" ")
        || n.resume?.title || String(n.id);
}

/** Сообщения по возрастанию времени; при равном времени — по id (HH отдаёт их вперемешку). */
function sortedByTime(messages: HhMessage[]): HhMessage[] {
    return [...messages].sort((a, b) => {
        const aa = String(a.created_at || ""), bb = String(b.created_at || "");
        if (aa === bb) return String(a.id).localeCompare(String(b.id));
        return aa.localeCompare(bb);
    });
}

function latest(messages: HhMessage[]): HhMessage | null {
    if (!messages.length) return null;
    return sortedByTime(messages).at(-1) ?? null;
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
    const text = buildCandidateCard({
        header: "❓ КАНДИДАТУ НУЖЕН ОТВЕТ",
        candidateName: chat.candidateName,
        vacancyName: chat.vacancyName,
        stage: chat.candidateStage,
        quote: question,
        action: "Ответьте reply на это сообщение — ответ уйдёт кандидату в HH.",
    });
    const deco = decorate(text, {
        vacancyName: chat.vacancyName,
        vacancyId: chat.vacancyId,
        candidateName: chat.candidateName,
        resumeUrl: chat.resumeUrl,
        html: true,
    });
    const opts: any = { ...candidateTelegramOptions };
    if (threadId) opts.message_thread_id = threadId;
    if (deco.keyboard) opts.reply_markup = deco.keyboard;
    const sent = await bot.api.sendMessage(groupChatId, deco.text, opts);
    createPendingQa({
        negotiationId: chat.negotiationId,
        messagesUrl: chat.messagesUrl,
        vacancyName: chat.vacancyName,
        spreadsheetId: chat.spreadsheetId,
        hhAccountId: chat.hhAccountId,
        candidateQuestion: question,
        tgChatId: groupChatId,
        tgThreadId: threadId ?? null,
        tgMessageId: sent.message_id,
    });
}

async function answerQuestion(bot: Bot, chat: EngagedChat, question: string): Promise<void> {
    const runToken = beginVacancyRun(chat.vacancyId);
    if (!canContinueVacancyRun(runToken)) return;
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
        if (!canContinueVacancyRun(runToken)) return;
        await escalateQuestionToTelegram(bot, chat, question);
        console.log(`[chat-router] ↑ эскалация (ИИ упал): ${chat.candidateName}`);
        return;
    }
    if (!canContinueVacancyRun(runToken)) return;
    if (decision.decision === "answer" && decision.answer) {
        await sendCandidateMessage(chat.messagesUrl, decision.answer);
        console.log(`[chat-router] ✔ ответил кандидату ${chat.candidateName}: "${question.slice(0, 50)}"`);
    } else {
        await escalateQuestionToTelegram(bot, chat, question);
        console.log(`[chat-router] ↑ эскалация в Telegram: ${chat.candidateName}: "${question.slice(0, 50)}"`);
    }
}

// Вопрос ли это (для стадии «Отклик»): true — кандидат ждёт ответа, false — самопрезентация/письмо/благодарность.
async function isCandidateQuestion(text: string): Promise<boolean> {
    const prompt = [
        "Кандидат в стадии отклика написал сообщение работодателю.",
        "Определи, содержит ли оно ВОПРОС/просьбу уточнить, на который кандидат ждёт ответа",
        "(об условиях, задачах, зарплате, графике, процессе, как связаться и т.п.).",
        "Верни только JSON: {\"question\": true|false}.",
        "true — есть вопрос или просьба уточнить.",
        "false — самопрезентация, сопроводительное письмо, благодарность, отказ, общие фразы без вопроса.",
        "",
        `Сообщение: ${text}`,
    ].join("\n");
    try {
        const r = parseAiJsonText(await askAi(prompt));
        return r?.question === true;
    } catch {
        return false;
    }
}

// Не вопрос от кандидата-отклика — просто пересылаем в тему вакансии (без авто-ответа).
async function forwardResponseToTelegram(bot: Bot, chat: EngagedChat, text: string): Promise<void> {
    const groupChatId = process.env.GROUP_CHAT_ID;
    if (!groupChatId) { console.warn("[chat-router] GROUP_CHAT_ID не задан, пересылка невозможна"); return; }
    const threadId = await findThreadId(bot, chat.vacancyName);
    const msg = buildCandidateCard({
        header: "📥 НОВОЕ СООБЩЕНИЕ ПО ОТКЛИКУ",
        candidateName: chat.candidateName,
        vacancyName: chat.vacancyName,
        stage: chat.candidateStage,
        quote: text,
        action: "При необходимости ответьте reply на это сообщение — ответ уйдёт кандидату в HH.",
    });
    const deco = decorate(msg, {
        vacancyName: chat.vacancyName,
        vacancyId: chat.vacancyId,
        candidateName: chat.candidateName,
        resumeUrl: chat.resumeUrl,
        html: true,
    });
    const opts: any = { ...candidateTelegramOptions };
    if (threadId) opts.message_thread_id = threadId;
    if (deco.keyboard) opts.reply_markup = deco.keyboard;
    const sent = await bot.api.sendMessage(groupChatId, deco.text, opts);
    // Даже если это благодарность или уведомление без вопроса, HR может ответить
    // reply прямо из Telegram. В архиве эта возможность намеренно не создаётся.
    createPendingQa({
        negotiationId: chat.negotiationId,
        messagesUrl: chat.messagesUrl,
        vacancyName: chat.vacancyName,
        spreadsheetId: chat.spreadsheetId,
        hhAccountId: chat.hhAccountId,
        candidateQuestion: text,
        tgChatId: groupChatId,
        tgThreadId: threadId ?? null,
        tgMessageId: sent.message_id,
    });
    console.log(`[chat-router] → отклик переслан в Telegram: ${chat.candidateName}`);
}

// Архивная вакансия: бот не может писать кандидату (403). Пересылаем сообщение в тему
// вакансии, чтобы HR ответил вручную. pendingQa НЕ создаём — ответ через бота всё равно
// упрётся в 403.
async function forwardArchivedToTelegram(bot: Bot, chat: EngagedChat, text: string): Promise<void> {
    const groupChatId = process.env.GROUP_CHAT_ID;
    if (!groupChatId) { console.warn("[chat-router] GROUP_CHAT_ID не задан, пересылка невозможна"); return; }
    const threadId = await findThreadId(bot, chat.vacancyName);
    const msg = buildCandidateCard({
        header: "🗄 НУЖЕН РУЧНОЙ ОТВЕТ",
        candidateName: chat.candidateName,
        vacancyName: chat.vacancyName,
        stage: chat.candidateStage,
        quote: text,
        action: "Вакансия находится в архиве. Откройте резюме кандидата и ответьте вручную в HH.",
    });
    const deco = decorate(msg, {
        vacancyName: chat.vacancyName,
        vacancyId: chat.vacancyId,
        candidateName: chat.candidateName,
        resumeUrl: chat.resumeUrl,
        html: true,
    });
    await bot.api.sendMessage(groupChatId, deco.text, {
        ...candidateTelegramOptions,
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...(deco.keyboard ? { reply_markup: deco.keyboard } : {}),
    });
    console.log(`[chat-router] 🗄 архив — сообщение переслано в Telegram: ${chat.candidateName}`);
}

// Прошедшие анкету (диалог о собеседовании) + при включённом флаге — кандидаты в стадии «Отклик».
async function buildEngagedChats(): Promise<EngagedChat[]> {
    const chats: EngagedChat[] = [];
    const seen = new Set<string>();
    let trackedVacancies: Awaited<ReturnType<typeof listTrackedVacancies>> = [];
    try { trackedVacancies = await listTrackedVacancies(); }
    catch (e: any) { console.error("[chat-router] не смог прочитать вакансии:", e.message); }
    const accountByVacancyId = new Map(trackedVacancies.map((v) => [v.vacancyId, v.hhAccountId]));
    const activeVacancyIds = new Set(trackedVacancies.map((v) => v.vacancyId));
    for (const st of listOpenInterviewChatStates()) {
        if (st.status === "closed" || !st.messagesUrl) continue;
        // Сохранённые диалоги переживают остановку вакансии. Не включаем их в
        // роутер, пока вакансия не активна в реестре.
        if (!activeVacancyIds.has(st.vacancyId) || isRuntimeVacancyStopped(st.vacancyId)) continue;
        const hhAccountId = st.hhAccountId || accountByVacancyId.get(st.vacancyId);
        if (!hhAccountId) {
            console.error(`[chat-router] не найден аккаунт HH для диалога ${st.negotiationId}`);
            continue;
        }
        chats.push({
            negotiationId: st.negotiationId,
            vacancyId: st.vacancyId,
            messagesUrl: st.messagesUrl,
            vacancyName: st.vacancyName,
            spreadsheetId: st.spreadsheetId,
            hasSchedulingState: true,
            isResponseStage: false,
            candidateName: st.candidateName,
            hhAccountId,
            candidateStage: "Собеседование",
            resumeUrl: st.resumeUrl,
        });
        seen.add(st.negotiationId);
    }
    if (RESPONSE_STAGE) {
        const vacancies = trackedVacancies;
        for (const v of vacancies) {
            if (isRuntimeVacancyStopped(v.vacancyId)) continue;
            const spreadsheetId = extractSpreadsheetId(v.templatesUrl);
            // Кандидаты «до собеседования» лежат в разных папках HH: отклик / рассмотрение / телефонное интервью.
            const sources: Array<{ fetch: (vacancyId: string) => Promise<HhNegotiation[]>; stage: CandidateStage }> = [
                { fetch: getNewResponses, stage: "Анализ резюме" },
                { fetch: getConsiderResponses, stage: "Анализ резюме" },
                { fetch: getPhoneInterviewResponses, stage: "Анализ анкеты" },
            ];
            for (const source of sources) {
                if (isRuntimeVacancyStopped(v.vacancyId)) break;
                try {
                    const negs = await withHhAccount(v.hhAccountId, () => source.fetch(v.vacancyId));
                    if (isRuntimeVacancyStopped(v.vacancyId)) break;
                    for (const n of negs) {
                        const id = String(n.id);
                        if (seen.has(id) || !n.messages_url) continue;
                        seen.add(id);
                        chats.push({
                            negotiationId: id,
                            vacancyId: v.vacancyId,
                            messagesUrl: n.messages_url,
                            vacancyName: v.vacancyName,
                            spreadsheetId,
                            hasSchedulingState: false,
                            isResponseStage: true,
                            candidateName: candName(n),
                            hhAccountId: v.hhAccountId,
                            candidateStage: source.stage,
                            resumeUrl: resumeLinkOf(n),
                        });
                    }
                }
                catch (e: any) { console.error(`[chat-router] выборка «${v.vacancyName}»:`, e.message); }
            }
        }
    }
    return chats;
}

/**
 * Записать ответ кандидата в лист «Ответы кандидатов».
 * Листа может не быть (вакансии с анкетой) — тогда просто ничего не делаем.
 * Ошибка записи не должна ломать разбор сообщения, поэтому глушим её здесь.
 */
async function recordAnswerSafely(chat: EngagedChat, text: string): Promise<void> {
    if (!chat.spreadsheetId || !chat.resumeUrl) return;
    try {
        const r = await recordCandidateAnswer(chat.spreadsheetId, {
            text,
            resumeUrl: chat.resumeUrl,
            fio: chat.candidateName,
        });
        if (r.written) console.log(`[answers] записан ответ: ${chat.candidateName} («${chat.vacancyName}»)`);
    } catch (e: any) {
        console.warn(`[answers] не записал ответ ${chat.candidateName}: ${e.message}`);
    }
}

export async function runChatRouter(bot: Bot): Promise<void> {
    const chats = await buildEngagedChats();
    for (const chat of chats) {
        const runToken = beginVacancyRun(chat.vacancyId);
        if (!canContinueVacancyRun(runToken)) continue;
        try {
            await withHhAccount(chat.hhAccountId, async () => {
            // Точечный боевой режим: LIVE_VACANCY_IDS форсит отправку по своей вакансии.
            const dry = DRY && !vacancyLiveOverride(chat.vacancyId);
            const messages = await getConversationMessages(chat.messagesUrl);
            if (!canContinueVacancyRun(runToken)) return;
            const applicantMsgs = messages.filter((m) => m.author?.participant_type === "applicant");
            const newestOverall = latest(applicantMsgs);
            if (!newestOverall) return;

            const cur = getCursor(chat.negotiationId);
            // первое появление чата — засеиваем курсор на текущее последнее сообщение и НЕ отвечаем на историю
            if (!cur) {
                setCursor(chat.negotiationId, {
                    lastId: String(newestOverall.id || ""),
                    lastAt: String(newestOverall.created_at || ""),
                });
                return;
            }

            const fresh = applicantMsgs.filter((m) => isNewer(m, cur));
            if (fresh.length === 0) return;

            const newest = latest(fresh)!;
            // Кандидат часто дробит мысль на несколько сообщений подряд:
            // «Смогу в пятницу 21.08 в 13:00» + «Или в любое время после 13:00».
            // Берём все новые сразу — иначе оставалось только последнее, и самое
            // важное (конкретный слот) терялось и для HR, и для разбора времени.
            const text = sortedByTime(fresh)
                .map((m) => String(m.text || "").trim())
                .filter(Boolean)
                .join("\n");
            const newCursor = { lastId: String(newest.id || ""), lastAt: String(newest.created_at || "") };

            if (!text) {
                setCursor(chat.negotiationId, newCursor);
                return;
            }

            // Архивная вакансия: писать кандидату нельзя (HH → 403). Не отвечаем и не
            // ведём диалог о собеседовании — пересылаем сообщение HR на ручной ответ.
            if (await isVacancyArchived(chat.vacancyId)) {
                // Пересылку на ручной ответ включает флаг уведомлений по архивным.
                if (process.env.ARCHIVED_NOTIFY_DRY_RUN !== "false") { console.log(`[chat-router:DRY] 🗄 архив ${chat.candidateName}: "${text.slice(0, 60)}" — на ручной ответ`); return; }
                if (!canContinueVacancyRun(runToken)) return;
                setCursor(chat.negotiationId, newCursor);
                await forwardArchivedToTelegram(bot, chat, text);
                return;
            }

            const schedState = chat.hasSchedulingState ? getInterviewChatState(chat.negotiationId) : null;

            // Стадия «Собеседование» / сценарий подтверждения — НЕ Q&A, а пересылка + подтверждение
            if (schedState && CONFIRM_STATUSES.has(schedState.status)) {
                if (dry) { console.log(`[chat-router:DRY] confirm-flow ${chat.candidateName}: "${text.slice(0, 60)}"`); return; }
                if (!canContinueVacancyRun(runToken)) return;
                setCursor(chat.negotiationId, newCursor);
                await handleConfirmationCandidateMessage(bot, schedState, text);
                return;
            }

            // Стадия «Отклик»: вопрос → отвечаем из базы (или эскалация), не вопрос → пересылаем в тему.
            if (chat.isResponseStage) {
                // Ответ на автосообщение складываем в лист «Ответы кандидатов» — по нему
                // HR примет решение. Пишем и в DRY: запись в таблицу кандидату не видна.
                await recordAnswerSafely(chat, text);
                if (!canContinueVacancyRun(runToken)) return;
                const q = await isCandidateQuestion(text);
                if (!canContinueVacancyRun(runToken)) return;
                if (dry) { console.log(`[chat-router:DRY] response-stage ${chat.candidateName}: question=${q} msg="${text.slice(0, 60)}"`); return; }
                setCursor(chat.negotiationId, newCursor);
                if (q) await answerQuestion(bot, chat, text);
                else await forwardResponseToTelegram(bot, chat, text);
                return;
            }

            let route: "scheduling" | "qa";
            let intent = "";
            if (schedState && schedState.status === "waiting_candidate_confirmation") {
                // Мы предложили кандидату слот и ждём его ответ (да/нет/другое время).
                // Короткое «да, вполне» — это ответ по слоту, а НЕ вопрос в базу знаний.
                route = "scheduling";
                intent = "scheduling(confirm)";
            } else if (schedState && schedState.status === "waiting_candidate_time") {
                // Мы пригласили и ждём, когда кандидату удобно. Любое его сообщение здесь —
                // часть согласования встречи, а не вопрос в базу знаний. Раньше это решал
                // классификатор и ошибался: ответ вида «смогу подойти 10 августа» уезжал
                // в Q&A, а ответ HR оседал в листе «Вопрос-ответ».
                route = "scheduling";
                intent = "scheduling(waiting-time)";
            } else {
                intent = await classifyIntent(text);
                if (!canContinueVacancyRun(runToken)) return;
                route = intent === "scheduling" && chat.hasSchedulingState ? "scheduling" : "qa";
            }

            if (dry) {
                console.log(`[chat-router:DRY] ${chat.vacancyName} / ${chat.candidateName}: intent=${intent} route=${route} msg="${text.slice(0, 60)}"`);
                return; // курсор не двигаем — при включении боевого режима сообщение обработается
            }

            if (!canContinueVacancyRun(runToken)) return;
            setCursor(chat.negotiationId, newCursor);
            if (route === "scheduling" && schedState) {
                await handleSchedulingMessage(bot, schedState, text);
            } else {
                await answerQuestion(bot, chat, text);
            }
            });
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
            const activeVacancy = (await listTrackedVacancies())
                .find((v) => v.vacancyName === pending.vacancyName);
            if (!activeVacancy || isRuntimeVacancyStopped(activeVacancy.vacancyId)) {
                throw new Error(`Вакансия «${pending.vacancyName}» приостановлена — ответ не отправлен`);
            }
            const accountId = pending.hhAccountId || activeVacancy.hhAccountId;
            if (!accountId) throw new Error(`Не найден аккаунт HH для вакансии «${pending.vacancyName}»`);
            await withHhAccount(accountId, () => sendCandidateMessage(pending.messagesUrl, answer));
            let saved = "";
            // База знаний ведётся вручную. Автосохранение отключено: в лист попадала
            // живая переписка (согласование встреч, «Да», личные детали), и потом бот
            // отвечал этим другим кандидатам. Включить обратно: QA_AUTOSAVE=true
            if (process.env.QA_AUTOSAVE === "true") {
                try {
                    const r = await appendVacancyQa(pending.spreadsheetId, pending.candidateQuestion, answer);
                    saved = r.appended
                        ? " Сохранил в лист «Вопрос-ответ»."
                        : ` В базу не добавил: вопрос уже есть как «${r.duplicateQuestion}».`;
                } catch (e: any) {
                    saved = ` (в базу не сохранил: ${e.message})`;
                }
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
