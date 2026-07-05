import { sheets } from "../google/sheets.client";
import type { VacancyGSTable } from "../types";
import { prisma } from "../lib/prisma.js";

const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES;
const range = process.env.GOOGLE_SHEETS_RANGE_VACANCIES;

async function getActiveVacanciesFromGS(): Promise<VacancyGSTable[]> {
    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_VACANCIES не указан в .env");
    if (!range) throw new Error("GOOGLE_SHEETS_RANGE_VACANCIES не указан в .env");

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];

    return rows
        .map((row) => ({
            vacancyName: String(row[0] || "").trim(),
            vacancyUrl: String(row[1] || "").trim() || null,
            templatesUrl: String(row[2] || "").trim() || null,
            responsibleUsername: String(row[3] || "").trim().replace("@", "").toLowerCase(),
        }))
        .filter((v) => v.vacancyName && v.responsibleUsername);
}

export async function syncActiveVacancies() {
    const vacancies = await getActiveVacanciesFromGS();
    const namesFromSheet = vacancies.map((v) => v.vacancyName);

    for (const vacancy of vacancies) {
        const responsibleUser = await prisma.user.findUnique({
            where: { username: vacancy.responsibleUsername },
        });

        const saved = await prisma.activeVacancy.upsert({
            where: { vacancyName: vacancy.vacancyName },
            update: {
                vacancyUrl: vacancy.vacancyUrl,
                templatesUrl: vacancy.templatesUrl,
                responsibleUsername: vacancy.responsibleUsername,
                responsibleUserId: responsibleUser?.id ?? null,
                isActive: true,
            },
            create: {
                vacancyName: vacancy.vacancyName,
                vacancyUrl: vacancy.vacancyUrl,
                templatesUrl: vacancy.templatesUrl,
                responsibleUsername: vacancy.responsibleUsername,
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
