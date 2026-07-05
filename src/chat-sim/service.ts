import type { Bot, Context } from "grammy";
import { findThreadId } from "../hhru/topics.store";
import {
    appendVacancyQa,
    extractSpreadsheetId,
    findTrackedVacancyByName,
    readVacancyQa,
} from "./vacancies";
import {
    appendSessionMessage,
    createPendingReply,
    createSession,
    getSession,
    resolvePendingReply,
    findPendingReplyByTelegramMessage,
    type ChatSession,
} from "./state.store";
import { decideCandidateAnswer } from "./ai-router";

interface AskQuestionInput {
    vacancyName: string;
    question: string;
    sessionId?: string;
}

export interface AskQuestionResult {
    session: ChatSession;
    status: "answered" | "pending_human";
    source: "ai" | "human";
}

function requireGroupChatId(): string {
    const chatId = process.env.GROUP_CHAT_ID;
    if (!chatId) throw new Error("GROUP_CHAT_ID не задан в .env");
    return chatId;
}

async function sendQuestionToTelegram(
    bot: Bot,
    vacancyName: string,
    question: string,
    reason: "kb_miss" | "ai_failed"
): Promise<{ chatId: string; threadId: number | null; messageId: number }> {
    const groupChatId = requireGroupChatId();
    const threadId = await findThreadId(bot, vacancyName);

    const header = reason === "ai_failed"
        ? `⚠️ ИИ не смог обработать вопрос по вакансии «${vacancyName}».`
        : `❓ Не нашёл ответ в базе знаний по вакансии «${vacancyName}».`;

    const text = [
        header,
        "",
        "Вопрос кандидата:",
        question,
        "",
        "Ответьте reply на это сообщение. Бот сохранит пару в лист «Вопрос-ответ».",
    ].join("\n");

    const sent = await bot.api.sendMessage(groupChatId, text, threadId ? { message_thread_id: threadId } : {});
    return { chatId: groupChatId, threadId: threadId ?? null, messageId: sent.message_id };
}

export async function handleSimulatedQuestion(bot: Bot, input: AskQuestionInput): Promise<AskQuestionResult> {
    const question = String(input.question || "").trim();
    if (!question) throw new Error("Вопрос пустой");

    const vacancy = await findTrackedVacancyByName(input.vacancyName);
    if (!vacancy) throw new Error(`Вакансия "${input.vacancyName}" не найдена`);

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl);
    if (!spreadsheetId) throw new Error(`У вакансии "${vacancy.vacancyName}" нет корректной Google Sheets ссылки`);

    const session = input.sessionId ? getSession(input.sessionId) : null;
    const currentSession = session ?? createSession(vacancy.vacancyName);

    if (currentSession.vacancyName !== vacancy.vacancyName) {
        throw new Error("Сессия привязана к другой вакансии");
    }

    appendSessionMessage(currentSession.id, "candidate", "candidate", question);

    const knowledgeBase = await readVacancyQa(spreadsheetId);

    try {
        const decision = await decideCandidateAnswer(vacancy.vacancyName, question, knowledgeBase);
        if (decision.decision === "answer") {
            const updatedSession = appendSessionMessage(currentSession.id, "assistant", "ai", decision.answer);
            return {
                session: updatedSession,
                status: "answered",
                source: "ai",
            };
        }

        const telegram = await sendQuestionToTelegram(bot, vacancy.vacancyName, question, "kb_miss");
        createPendingReply({
            sessionId: currentSession.id,
            vacancyName: vacancy.vacancyName,
            spreadsheetId,
            candidateQuestion: question,
            telegramChatId: telegram.chatId,
            telegramThreadId: telegram.threadId,
            telegramMessageId: telegram.messageId,
            source: "kb_miss",
        });

        const updatedSession = appendSessionMessage(
            currentSession.id,
            "system",
            "system",
            "Ответа в базе знаний не нашлось. Вопрос отправлен в Telegram ответственному."
        );
        return {
            session: updatedSession,
            status: "pending_human",
            source: "human",
        };
    } catch (error: any) {
        console.error("[chat-sim] ошибка ИИ, отправляю вопрос в Telegram:", error);

        const telegram = await sendQuestionToTelegram(bot, vacancy.vacancyName, question, "ai_failed");
        createPendingReply({
            sessionId: currentSession.id,
            vacancyName: vacancy.vacancyName,
            spreadsheetId,
            candidateQuestion: question,
            telegramChatId: telegram.chatId,
            telegramThreadId: telegram.threadId,
            telegramMessageId: telegram.messageId,
            source: "ai_failed",
        });

        const updatedSession = appendSessionMessage(
            currentSession.id,
            "system",
            "system",
            "ИИ сейчас недоступен. Ответ кандидату не отправлен, вопрос перенесён в Telegram."
        );
        return {
            session: updatedSession,
            status: "pending_human",
            source: "human",
        };
    }
}

export function registerTelegramQaReplyHandler(bot: Bot<Context>) {
    bot.on("message:text", async (ctx) => {
        const message = ctx.message;
        const groupChatId = process.env.GROUP_CHAT_ID;
        if (!groupChatId || String(ctx.chat.id) !== groupChatId) return;
        if (!message.reply_to_message) return;

        const pending = findPendingReplyByTelegramMessage(String(ctx.chat.id), message.reply_to_message.message_id);
        if (!pending) return;

        const answer = String(message.text || "").trim();
        if (!answer) {
            await ctx.reply("Нужен текстовый reply, чтобы я сохранил ответ в лист «Вопрос-ответ».", {
                reply_parameters: { message_id: message.message_id },
            });
            return;
        }

        try {
            const appendResult = await appendVacancyQa(pending.spreadsheetId, pending.candidateQuestion, answer);
            resolvePendingReply(pending.id, answer);
            appendSessionMessage(pending.sessionId, "assistant", "human", answer);

            await ctx.reply(
                appendResult.appended
                    ? "Сохранил ответ в лист «Вопрос-ответ» и закрыл вопрос кандидата."
                    : `Ответ получил и закрыл вопрос. В базу не добавлял: вопрос уже есть как «${appendResult.duplicateQuestion}».`,
                { reply_parameters: { message_id: message.message_id } }
            );
        } catch (error: any) {
            console.error("[chat-sim] ошибка сохранения ответа из Telegram:", error);
            await ctx.reply(`Не смог сохранить ответ: ${error.message}`, {
                reply_parameters: { message_id: message.message_id },
            });
        }
    });
}
