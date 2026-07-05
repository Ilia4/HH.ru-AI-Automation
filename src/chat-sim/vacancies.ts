import { sheets } from "../google/sheets.client";

export interface TrackedVacancy {
    vacancyName: string;
    hhUrl: string;
    vacancyId: string;
    templatesUrl: string;
    responsible: string;
}

export interface VacancyQaItem {
    question: string;
    answer: string;
    rowNumber: number;
}

const QA_SHEET_NAME = "Вопрос-ответ";

export function extractSpreadsheetId(url: string): string {
    const match = String(url || "").match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : "";
}

function extractVacancyId(url: string): string {
    const match = String(url || "").match(/\/vacancy\/(\d+)/);
    return match ? match[1] : "";
}

export function normalizeQuestion(text: string): string {
    return String(text || "")
        .toLowerCase()
        .replace(/^\s*\d+\.\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
}

export async function listTrackedVacancies(): Promise<TrackedVacancy[]> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES;
    const range = process.env.GOOGLE_SHEETS_RANGE_VACANCIES || "Лист1!A:D";

    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_VACANCIES не указан в .env");

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];

    return rows
        .map((row) => ({
            vacancyName: String(row[0] || "").trim(),
            hhUrl: String(row[1] || "").trim(),
            templatesUrl: String(row[2] || "").trim(),
            responsible: String(row[3] || "").trim(),
        }))
        .filter((vacancy) => vacancy.vacancyName && vacancy.hhUrl && vacancy.templatesUrl && vacancy.responsible)
        .map((vacancy) => ({
            ...vacancy,
            vacancyId: extractVacancyId(vacancy.hhUrl),
        }))
        .filter((vacancy) => vacancy.vacancyId);
}

export async function findTrackedVacancyByName(name: string): Promise<TrackedVacancy | null> {
    const normalized = String(name || "").trim().toLowerCase();
    const vacancies = await listTrackedVacancies();
    return vacancies.find((vacancy) => vacancy.vacancyName.trim().toLowerCase() === normalized) ?? null;
}

export async function readVacancyQa(spreadsheetId: string): Promise<VacancyQaItem[]> {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${QA_SHEET_NAME}!A:B`,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return [];

    return rows.slice(1)
        .map((row, index) => ({
            question: String(row[0] || "").trim(),
            answer: String(row[1] || "").trim(),
            rowNumber: index + 2,
        }))
        .filter((item) => item.question && item.answer);
}

export async function appendVacancyQa(
    spreadsheetId: string,
    question: string,
    answer: string
): Promise<{ appended: boolean; duplicateQuestion?: string }> {
    const normalizedQuestion = normalizeQuestion(question);
    const existing = await readVacancyQa(spreadsheetId);
    const duplicate = existing.find((item) => normalizeQuestion(item.question) === normalizedQuestion);

    if (duplicate) {
        return { appended: false, duplicateQuestion: duplicate.question };
    }

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${QA_SHEET_NAME}!A:B`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [[question, answer]],
        },
    });

    return { appended: true };
}
