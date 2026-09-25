import { Bot } from "grammy";
import { prisma } from "../lib/prisma.js";
import { buildCandidateCard, escapeTelegramHtml, resumeLinkHtml } from "../hhru/telegram-cards";

const INTERVIEW_TIME_ZONE = "Europe/Moscow";

/** В БД хранится абсолютный UTC-момент, а HR всегда должен видеть московское время. */
export function formatInterviewDateMoscow(value: Date): string {
    return value.toLocaleDateString("ru-RU", { timeZone: INTERVIEW_TIME_ZONE });
}

export function formatInterviewTimeMoscow(value: Date): string {
    return value.toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: INTERVIEW_TIME_ZONE,
    });
}

// Группируем массив объектов по ключу
function groupBy<T>(items: T[], key: (item: T) => number): Map<number, T[]> {
    const map = new Map<number, T[]>();
    for (const item of items) {
        const k = key(item);
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(item);
    }
    return map;
}

export async function sendNewVacancyNotifications(bot: Bot) {
    const vacancies = await prisma.activeVacancy.findMany({
        where: {
            responsibleNotifiedAt: null,
            isActive: true,
            responsibleUserId: { not: null },
        },
    });

    if (vacancies.length === 0) return;

    const byUser = groupBy(vacancies, (v) => v.responsibleUserId!);

    for (const [userId, userVacancies] of byUser) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            console.log(`[vacancy-notify] пользователь ${userId} не найден, пропускаем`);
            continue;
        }

        const lines: string[] = [];

        if (userVacancies.length === 1) {
            const v = userVacancies[0];
            lines.push(`🎯 <b>Вас назначили ответственным за вакансию</b>`, ``);
            lines.push(`<b>Вакансия:</b> ${escapeTelegramHtml(v.vacancyName)}`);
            if (v.vacancyUrl) lines.push(`<b>Ссылка:</b> ${escapeTelegramHtml(v.vacancyUrl)}`);
            if (v.templatesUrl) lines.push(`<b>Шаблоны:</b> ${escapeTelegramHtml(v.templatesUrl)}`);
        } else {
            lines.push(`🎯 <b>Вас назначили ответственным за ${userVacancies.length} вакансии</b>`, ``);
            for (const v of userVacancies) {
                lines.push(`• <b>${escapeTelegramHtml(v.vacancyName)}</b>`);
                if (v.vacancyUrl) lines.push(`  Ссылка: ${escapeTelegramHtml(v.vacancyUrl)}`);
                if (v.templatesUrl) lines.push(`  Шаблоны: ${escapeTelegramHtml(v.templatesUrl)}`);
                lines.push(``);
            }
        }

        lines.push(`Если по вакансиям будут назначены собеседования, я пришлю уведомление 🙂`);

        try {
            await bot.api.sendMessage(user.tgUserId, lines.join("\n"), { parse_mode: "HTML" });

            await prisma.activeVacancy.updateMany({
                where: { id: { in: userVacancies.map((v) => v.id) } },
                data: { responsibleNotifiedAt: new Date() },
            });

            console.log(`[vacancy-notify] отправлено → @${user.username}: ${userVacancies.map((v) => v.vacancyName).join(", ")}`);
        } catch (err) {
            console.error(`[vacancy-notify] ошибка для пользователя ${userId}:`, err);
        }
    }
}

export async function sendNewInterviewNotifications(bot: Bot) {
    const pending = await prisma.interviewNotification.findMany({
        where: {
            firstNotificationSentAt: null,
            status: "active",
            responsibleUserId: { not: null },
        },
    });

    if (pending.length === 0) return;

    const byUser = groupBy(pending, (n) => n.responsibleUserId!);

    for (const [userId, notifications] of byUser) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            console.log(`[notify] пользователь ${userId} не найден, пропускаем`);
            continue;
        }

        const lines: string[] = [];

        if (notifications.length === 1) {
            const n = notifications[0];
            const date = formatInterviewDateMoscow(n.interviewAt);
            const time = formatInterviewTimeMoscow(n.interviewAt);

            const card = buildCandidateCard({
                header: "📋 НАЗНАЧЕНО СОБЕСЕДОВАНИЕ",
                candidateName: n.candidateFullName,
                vacancyName: n.vacancyName,
                stage: "Собеседование",
                fields: [
                    { icon: "🗓", label: "Дата", value: date },
                    { icon: "🕐", label: "Время", value: time },
                    ...(n.contactCandidate ? [{ icon: "☎️", label: "Связь", value: n.contactCandidate }] : []),
                ],
            });
            lines.push(card);
            const resume = resumeLinkHtml(n.resumeUrl);
            if (resume) lines.push(``, resume);
        } else {
            lines.push(`📋 <b>Назначено ${notifications.length} собеседования</b>`, ``);
            for (const n of notifications) {
                const date = formatInterviewDateMoscow(n.interviewAt);
                const time = formatInterviewTimeMoscow(n.interviewAt);

                lines.push(`👤 <b>${escapeTelegramHtml(n.candidateFullName)}</b>`);
                lines.push(`  💼 ${escapeTelegramHtml(n.vacancyName)}`);
                lines.push(`  📅 ${date} в ${time}`);
                lines.push(`  📍 Этап кандидата: Собеседование`);
                if (n.contactCandidate) lines.push(`  ☎️ ${escapeTelegramHtml(n.contactCandidate)}`);
                const resume = resumeLinkHtml(n.resumeUrl);
                if (resume) lines.push(`  ${resume}`);
                lines.push(``);
            }
        }

        try {
            await bot.api.sendMessage(user.tgUserId, lines.join("\n"), { parse_mode: "HTML" });

            await prisma.interviewNotification.updateMany({
                where: { id: { in: notifications.map((n) => n.id) } },
                data: { firstNotificationSentAt: new Date() },
            });

            console.log(`[notify] отправлено → @${user.username}: ${notifications.length} собеседований`);
        } catch (err) {
            console.error(`[notify] ошибка для пользователя ${userId}:`, err);
        }
    }
}

export async function send30MinReminders(bot: Bot) {
    const now = new Date();

    const pending = await prisma.interviewNotification.findMany({
        where: {
            reminderAt: { lte: now },
            reminder30SentAt: null,
            status: "active",
            responsibleUserId: { not: null },
        },
    });

    if (pending.length === 0) return;

    const byUser = groupBy(pending, (n) => n.responsibleUserId!);

    for (const [userId, notifications] of byUser) {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            console.log(`[remind] пользователь ${userId} не найден, пропускаем`);
            continue;
        }

        const lines: string[] = [];

        if (notifications.length === 1) {
            const n = notifications[0];
            const time = formatInterviewTimeMoscow(n.interviewAt);

            const card = buildCandidateCard({
                header: "⏰ СОБЕСЕДОВАНИЕ ЧЕРЕЗ 30 МИНУТ",
                candidateName: n.candidateFullName,
                vacancyName: n.vacancyName,
                stage: "Собеседование",
                fields: [
                    { icon: "🕐", label: "Время", value: time },
                    ...(n.contactCandidate ? [{ icon: "☎️", label: "Связь", value: n.contactCandidate }] : []),
                ],
            });
            lines.push(card);
            const resume = resumeLinkHtml(n.resumeUrl);
            if (resume) lines.push(``, resume);
        } else {
            lines.push(`⏰ <b>Через 30 минут ${notifications.length} собеседования</b>`, ``);
            for (const n of notifications) {
                const time = formatInterviewTimeMoscow(n.interviewAt);
                lines.push(`👤 <b>${escapeTelegramHtml(n.candidateFullName)}</b>`);
                lines.push(`  💼 ${escapeTelegramHtml(n.vacancyName)}`);
                lines.push(`  🕐 ${time}`);
                lines.push(`  📍 Этап кандидата: Собеседование`);
                if (n.contactCandidate) lines.push(`  ☎️ ${escapeTelegramHtml(n.contactCandidate)}`);
                const resume = resumeLinkHtml(n.resumeUrl);
                if (resume) lines.push(`  ${resume}`);
                lines.push(``);
            }
        }

        try {
            await bot.api.sendMessage(user.tgUserId, lines.join("\n"), { parse_mode: "HTML" });

            await prisma.interviewNotification.updateMany({
                where: { id: { in: notifications.map((n) => n.id) } },
                data: { reminder30SentAt: new Date() },
            });

            console.log(`[remind] 30-мин напоминание → @${user.username}: ${notifications.length} собеседований`);
        } catch (err) {
            console.error(`[remind] ошибка для пользователя ${userId}:`, err);
        }
    }
}
