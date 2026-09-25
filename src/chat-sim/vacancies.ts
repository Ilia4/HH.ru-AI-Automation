import { sheets } from "../google/sheets.client";
import { cached, invalidatePrefix } from "../lib/sheet-cache";
import { listHhAccounts, normalizeAccountEmail } from "../hh-auth/accounts.service";
import { parseVacancyMode, setVacancyModes, type VacancyMode } from "../hhru/vacancy-mode";
import { parseWorkflowMode, type WorkflowMode } from "../hhru/workflow-mode";

export interface TrackedVacancy {
    vacancyName: string;
    hhUrl: string;
    vacancyId: string;
    templatesUrl: string;
    responsible: string;
    hhAccountId: string;
    hhAccountEmail: string;
    /** «боевой» — можно писать кандидатам, «тест» — только анализ */
    mode: VacancyMode;
    workflow: WorkflowMode;
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
    // Реестр вакансий читают почти все ветки бота — держим его в кэше.
    const vacancies = await cached("registry:vacancies", loadTrackedVacancies);
    // Снимок режимов обновляем и на попаданиях в кэш: проверка режима синхронная,
    // и ей нужен актуальный список, кто сейчас в боевом режиме.
    setVacancyModes(vacancies.map((v) => ({ vacancyId: v.vacancyId, mode: v.mode })));
    return vacancies;
}

async function loadTrackedVacancies(): Promise<TrackedVacancy[]> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES;
    // H — сценарий после анализа резюме (анкета / вопрос в HH).
    const configuredRange = process.env.GOOGLE_SHEETS_RANGE_VACANCIES || "Лист1!A:H";
    const range = configuredRange.replace(/:[A-Z]+(\d*)$/i, ":H$1");

    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_VACANCIES не указан в .env");

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];
    const accounts = await listHhAccounts();
    const accountsByEmail = new Map(accounts.map((account) => [normalizeAccountEmail(account.email), account]));
    const missingAccounts = new Set<string>();

    const vacancies = rows
        .map((row) => {
            const vacancyName = String(row[0] || "").trim();
            return {
            vacancyName,
            hhUrl: String(row[1] || "").trim(),
            templatesUrl: String(row[2] || "").trim(),
            responsible: String(row[3] || "").trim(),
            hhAccountEmail: normalizeAccountEmail(String(row[4] || "")),
            mode: parseVacancyMode(row[6]),
            workflow: parseWorkflowMode(row[7], vacancyName),
        };})
        // Активна только полностью заполненная строка, включая аккаунт HH.
        .filter((vacancy) =>
            vacancy.vacancyName &&
            vacancy.hhUrl &&
            vacancy.templatesUrl &&
            vacancy.responsible &&
            vacancy.hhAccountEmail
        )
        .map((vacancy) => ({
            ...vacancy,
            vacancyId: extractVacancyId(vacancy.hhUrl),
            hhAccountId: accountsByEmail.get(vacancy.hhAccountEmail)?.id || "",
        }))
        .filter((vacancy) => {
            if (!vacancy.vacancyId) return false;
            if (!vacancy.hhAccountId) {
                missingAccounts.add(vacancy.hhAccountEmail);
                return false;
            }
            return true;
        });

    for (const email of missingAccounts) {
        console.warn(`[vacancies] аккаунт HH «${email}» ещё не подключён — его вакансии пока неактивны`);
    }
    return vacancies;
}

export async function findTrackedVacancyByName(name: string): Promise<TrackedVacancy | null> {
    const normalized = String(name || "").trim().toLowerCase();
    const vacancies = await listTrackedVacancies();
    return vacancies.find((vacancy) => vacancy.vacancyName.trim().toLowerCase() === normalized) ?? null;
}

export async function readVacancyQa(spreadsheetId: string): Promise<VacancyQaItem[]> {
    return cached(`qa:${spreadsheetId}`, () => loadVacancyQa(spreadsheetId));
}

async function loadVacancyQa(spreadsheetId: string): Promise<VacancyQaItem[]> {
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

    invalidatePrefix(`qa:${spreadsheetId}`);
    return { appended: true };
}
