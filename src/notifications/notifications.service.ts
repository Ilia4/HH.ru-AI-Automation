import { Bot } from "grammy";
import { prisma } from "../lib/prisma.js";

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
            lines.push(`<b>Вакансия:</b> ${v.vacancyName}`);
            if (v.vacancyUrl) lines.push(`<b>Ссылка:</b> ${v.vacancyUrl}`);
            if (v.templatesUrl) lines.push(`<b>Шаблоны:</b> ${v.templatesUrl}`);
        } else {
            lines.push(`🎯 <b>Вас назначили ответственным за ${userVacancies.length} вакансии</b>`, ``);
            for (const v of userVacancies) {
                lines.push(`• <b>${v.vacancyName}</b>`);
                if (v.vacancyUrl) lines.push(`  Ссылка: ${v.vacancyUrl}`);
                if (v.templatesUrl) lines.push(`  Шаблоны: ${v.templatesUrl}`);
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
            const date = n.interviewAt.toLocaleDateString("ru-RU");
            const time = n.interviewAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

            lines.push(`📋 <b>Назначено собеседование</b>`, ``);
            lines.push(`<b>Вакансия:</b> ${n.vacancyName}`);
            lines.push(`<b>Кандидат:</b> ${n.candidateFullName}`);
            lines.push(`<b>Дата:</b> ${date}`);
            lines.push(`<b>Время:</b> ${time}`);
            if (n.resumeUrl) lines.push(`<b>Резюме:</b> ${n.resumeUrl}`);
            if (n.contactCandidate) lines.push(`<b>Связь с кандидатом:</b> ${n.contactCandidate}`);
        } else {
            lines.push(`📋 <b>Назначено ${notifications.length} собеседования</b>`, ``);
            for (const n of notifications) {
                const date = n.interviewAt.toLocaleDateString("ru-RU");
                const time = n.interviewAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

                lines.push(`• <b>${n.vacancyName}</b> — ${n.candidateFullName}`);
                lines.push(`  📅 ${date} в ${time}`);
                if (n.resumeUrl) lines.push(`  Резюме: ${n.resumeUrl}`);
                if (n.contactCandidate) lines.push(`  Связь: ${n.contactCandidate}`);
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
            const time = n.interviewAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

            lines.push(`⏰ <b>Через 30 минут собеседование</b>`, ``);
            lines.push(`<b>Вакансия:</b> ${n.vacancyName}`);
            lines.push(`<b>Кандидат:</b> ${n.candidateFullName}`);
            lines.push(`<b>Время:</b> ${time}`);
            if (n.contactCandidate) lines.push(`<b>Связь с кандидатом:</b> ${n.contactCandidate}`);
        } else {
            lines.push(`⏰ <b>Через 30 минут ${notifications.length} собеседования</b>`, ``);
            for (const n of notifications) {
                const time = n.interviewAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
                lines.push(`• <b>${n.vacancyName}</b> — ${n.candidateFullName} в ${time}`);
                if (n.contactCandidate) lines.push(`  Связь: ${n.contactCandidate}`);
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
