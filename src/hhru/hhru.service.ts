import { sheets } from "../google/sheets.client";
import { processVacancyResponses } from "./process-responses";
import { processVacancyQuestionnaire, type QuestionnaireSummary } from "./questionnaire";

// Блокировка от параллельных запусков обработки откликов
let hhruBusy = false;
export function isHhruBusy(): boolean {
    return hhruBusy;
}

// Отдельная блокировка для обработки анкет
let anketaBusy = false;

/** Прогон анкет по всем вакансиям (или по фильтру). Без действий на HH — только анализ и запись в таблицу. */
export async function processAllQuestionnaires(filter?: string): Promise<{ vacancyName: string; summary: QuestionnaireSummary }[]> {
    if (anketaBusy) throw new Error("ANKETA_BUSY");
    anketaBusy = true;
    try {
        let vacancies = await getTrackedVacancies();
        if (filter) vacancies = vacancies.filter((v) => v.vacancyName.toLowerCase().includes(filter.toLowerCase()));
        const out: { vacancyName: string; summary: QuestionnaireSummary }[] = [];
        for (const v of vacancies) {
            try {
                const summary = await processVacancyQuestionnaire({
                    vacancyId: v.vacancyId,
                    vacancyName: v.vacancyName,
                    templatesUrl: v.templatesUrl,
                });
                out.push({ vacancyName: v.vacancyName, summary });
            } catch (e: any) {
                console.error(`[anketa] ошибка "${v.vacancyName}": ${e.message}`);
                out.push({
                    vacancyName: v.vacancyName,
                    summary: { total_forms: 0, evaluated: 0, passed: 0, failed: 0, skipped_no_match: 0, skipped_processed: 0, message: `ошибка: ${e.message}` },
                });
            }
        }
        return out;
    } finally {
        anketaBusy = false;
    }
}

const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES;
const range = "Лист1!A:D";

interface TrackedVacancy {
    vacancyName: string;
    hhUrl: string;
    vacancyId: string;
    templatesUrl: string | null;
    responsible: string;
}

async function getTrackedVacancies(): Promise<TrackedVacancy[]> {
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
        // вакансия активна, только если заполнены ВСЕ колонки (название, ссылка HH, шаблоны, ответственный)
        .filter((v) => {
            const allFilled = v.vacancyName && v.hhUrl && v.templatesUrl && v.responsible;
            if (!allFilled) return false;
            if (!v.hhUrl.includes("hh.ru/vacancy/")) return false;
            return true;
        })
        .map((v) => ({
            vacancyName: v.vacancyName,
            hhUrl: v.hhUrl,
            templatesUrl: v.templatesUrl,
            responsible: v.responsible,
            vacancyId: extractVacancyId(v.hhUrl),
        }))
        .filter((v) => v.vacancyId !== "");
}

function extractVacancyId(url: string): string {
    const match = url.match(/\/vacancy\/(\d+)/);
    return match ? match[1] : "";
}

export interface VacancyN8nResult {
    vacancyName: string;
    success: boolean;
    data?: {
        vacancy_id: string;
        vacancy_name: string;
        message?: string;
        new_responses?: {
            has_new_responses: boolean;
            total: number;
            passed_count: number;
            manual_count: number;
            failed_count: number;
            message: string;
            text: string;
        };
        manual_check?: {
            checked: boolean;
            processed_total: number;
            accepted_count: number;
            rejected_count: number;
            message: string;
        };
    };
    error?: string;
}

export async function sendVacanciesToN8n(filter?: string): Promise<VacancyN8nResult[]> {
    const webhookUrl = process.env.N8N_WEBHOOK_HHRU;
    const questionnaireUrl = process.env.N8N_WEBHOOK_QUESTIONNAIRE;
    const useLocal = process.env.USE_LOCAL_PROCESSING === "true";
    const dryRun = process.env.HHRU_DRY_RUN !== "false"; // по умолчанию dry-run

    let vacancies = await getTrackedVacancies();

    if (vacancies.length === 0) {
        console.log("[hhru] нет вакансий с ссылками на HH.ru");
        return [];
    }

    if (filter) {
        vacancies = vacancies.filter(v => v.vacancyName.toLowerCase().includes(filter.toLowerCase()));
        if (vacancies.length === 0) {
            console.log(`[hhru] нет вакансий по фильтру "${filter}"`);
            return [];
        }
    }

    // ===== Локальная обработка на TypeScript (без n8n) =====
    if (useLocal) {
        if (hhruBusy) {
            console.warn("[hhru] обработка уже выполняется — пропускаю параллельный запуск");
            throw new Error("HHRU_BUSY");
        }
        hhruBusy = true;
        console.log(`[hhru] локальная обработка ${vacancies.length} вакансий (dryRun=${dryRun})`);
        const results: VacancyN8nResult[] = [];
        try {
            for (const vacancy of vacancies) {
                try {
                    const data = await processVacancyResponses(
                        { vacancyId: vacancy.vacancyId, vacancyName: vacancy.vacancyName, templatesUrl: vacancy.templatesUrl },
                        { dryRun }
                    );
                    results.push({ vacancyName: vacancy.vacancyName, success: true, data });
                } catch (err: any) {
                    console.error(`[hhru] локальная ошибка "${vacancy.vacancyName}":`, err.message);
                    results.push({ vacancyName: vacancy.vacancyName, success: false, error: err.message });
                }
            }
        } finally {
            hhruBusy = false;
        }
        return results;
    }

    // ===== Старый путь через n8n =====
    if (!webhookUrl) {
        console.warn("[hhru] N8N_WEBHOOK_HHRU не задан в .env, пропускаем");
        return [];
    }

    console.log(`[hhru] отправляем ${vacancies.length} вакансий в n8n`);

    const results: VacancyN8nResult[] = [];

    for (const vacancy of vacancies) {
        const payload = {
            vacancyId: vacancy.vacancyId,
            vacancyUrl: vacancy.hhUrl,
            vacancyName: vacancy.vacancyName,
            templatesUrl: vacancy.templatesUrl,
        };

        try {
            const response = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                console.error(`[hhru] n8n вернул ${response.status} для вакансии "${vacancy.vacancyName}"`);
                results.push({ vacancyName: vacancy.vacancyName, success: false, error: `HTTP ${response.status}` });
            } else {
                const data = await response.json() as VacancyN8nResult["data"];
                console.log(`[hhru] обработано: "${vacancy.vacancyName}"`);
                results.push({ vacancyName: vacancy.vacancyName, success: true, data });
            }
        } catch (err: any) {
            console.error(`[hhru] ошибка отправки "${vacancy.vacancyName}":`, err);
            results.push({ vacancyName: vacancy.vacancyName, success: false, error: err.message });
            continue;
        }

        // После обработки откликов — вызываем вебхук анкет
        if (questionnaireUrl) {
            try {
                console.log(`[questionnaire] вызываю для "${vacancy.vacancyName}"`);
                const qResponse = await fetch(questionnaireUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                if (!qResponse.ok) {
                    console.error(`[questionnaire] n8n вернул ${qResponse.status} для "${vacancy.vacancyName}"`);
                } else {
                    console.log(`[questionnaire] обработано: "${vacancy.vacancyName}"`);
                }
            } catch (err: any) {
                console.error(`[questionnaire] ошибка для "${vacancy.vacancyName}":`, err.message);
            }
        }
    }

    return results;
}
