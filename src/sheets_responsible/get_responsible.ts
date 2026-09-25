import { prisma } from "../lib/prisma.js";
import { listTrackedVacancies } from "../chat-sim/vacancies";

export async function syncActiveVacancies() {
    const vacancies = await listTrackedVacancies();
    const namesFromSheet = vacancies.map((v) => v.vacancyName);

    for (const vacancy of vacancies) {
        const responsibleUser = await prisma.user.findUnique({
            where: { username: vacancy.responsible.replace("@", "").toLowerCase() },
        });

        const saved = await prisma.activeVacancy.upsert({
            where: { vacancyName: vacancy.vacancyName },
            update: {
                vacancyUrl: vacancy.hhUrl,
                templatesUrl: vacancy.templatesUrl,
                vacancyId: vacancy.vacancyId,
                hhAccountId: vacancy.hhAccountId,
                responsibleUsername: vacancy.responsible.replace("@", "").toLowerCase(),
                responsibleUserId: responsibleUser?.id ?? null,
                isActive: true,
            },
            create: {
                vacancyName: vacancy.vacancyName,
                vacancyUrl: vacancy.hhUrl,
                templatesUrl: vacancy.templatesUrl,
                vacancyId: vacancy.vacancyId,
                hhAccountId: vacancy.hhAccountId,
                responsibleUsername: vacancy.responsible.replace("@", "").toLowerCase(),
                responsibleUserId: responsibleUser?.id ?? null,
                isActive: true,
            },
        });

        console.log(
            `[vacancies] ${saved.vacancyName} — ответственный: @${saved.responsibleUsername}` +
            (responsibleUser ? ` (userId: ${responsibleUser.id})` : " (пользователь не найден в БД)")
        );
    }

    // Деактивировать вакансии, которых больше нет в таблице
    const deactivated = await prisma.activeVacancy.updateMany({
        where: {
            vacancyName: { notIn: namesFromSheet },
            isActive: true,
        },
        data: { isActive: false },
    });

    if (deactivated.count > 0) {
        console.log(`[vacancies] деактивировано ${deactivated.count} вакансий`);
    }

    console.log(`[vacancies] синхронизировано: ${vacancies.length}`);
}
