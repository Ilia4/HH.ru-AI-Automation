import { processVacancyResponses } from "./process-responses";
import { processVacancyQuestionnaire, type QuestionnaireSummary } from "./questionnaire";
import { processCandidateAnswers } from "./candidate-answers";
import { listTrackedVacancies } from "../chat-sim/vacancies";
import { withHhAccount } from "../hh-auth/account-context";
import { isRuntimeVacancyStopped } from "./vacancy-activity";

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
        let vacancies = (await listTrackedVacancies()).filter((v) => v.workflow === "questionnaire");
        if (filter) vacancies = vacancies.filter((v) => v.vacancyName.toLowerCase().includes(filter.toLowerCase()));
        const out: { vacancyName: string; summary: QuestionnaireSummary }[] = [];
        for (const v of vacancies) {
            if (isRuntimeVacancyStopped(v.vacancyId)) {
                console.log(`[anketa] «${v.vacancyName}» приостановлена — пропуск`);
                continue;
            }
            try {
                const summary = await withHhAccount(v.hhAccountId, () =>
                    processVacancyQuestionnaire({
                        vacancyId: v.vacancyId,
                        vacancyName: v.vacancyName,
                        templatesUrl: v.templatesUrl,
                    })
                );
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

/**
 * Решения HR из листа «Ответы кандидатов» по всем вакансиям.
 * У вакансий без этого листа ветка молчит — там отбор идёт по анкете.
 */
export async function processAllCandidateAnswers(): Promise<{ invited: number; rejected: number; skipped: number }> {
    const totals = { invited: 0, rejected: 0, skipped: 0 };
    for (const v of (await listTrackedVacancies()).filter((item) => item.workflow === "chat_question")) {
        if (isRuntimeVacancyStopped(v.vacancyId)) {
            console.log(`[answers] «${v.vacancyName}» приостановлена — пропуск`);
            continue;
        }
        try {
            const r = await withHhAccount(v.hhAccountId, () =>
                processCandidateAnswers({
                    vacancyId: v.vacancyId,
                    vacancyName: v.vacancyName,
                    templatesUrl: v.templatesUrl,
                })
            );
            if (!r.checked) continue;
            totals.invited += r.invited;
            totals.rejected += r.rejected;
            totals.skipped += r.skipped;
            if (r.invited || r.rejected || r.skipped) {
                console.log(`[answers] «${v.vacancyName}»: приглашений ${r.invited}, отказов ${r.rejected}, пропущено ${r.skipped}`);
            }
        } catch (e: any) {
            console.error(`[answers] ошибка по «${v.vacancyName}»: ${e.message}`);
        }
    }
    return totals;
}

export interface VacancyN8nResult {
    vacancyName: string;
    hhAccountId: string;
    hhAccountEmail: string;
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

    let vacancies = await listTrackedVacancies();

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
                if (isRuntimeVacancyStopped(vacancy.vacancyId)) {
                    console.log(`[hhru] «${vacancy.vacancyName}» приостановлена во время прохода — пропуск`);
                    continue;
                }
                try {
                    const data = await withHhAccount(vacancy.hhAccountId, () =>
                        processVacancyResponses(
                            { vacancyId: vacancy.vacancyId, vacancyName: vacancy.vacancyName, templatesUrl: vacancy.templatesUrl },
                            { dryRun }
                        )
                    );
                    results.push({
                        vacancyName: vacancy.vacancyName,
                        hhAccountId: vacancy.hhAccountId,
                        hhAccountEmail: vacancy.hhAccountEmail,
                        success: true,
                        data,
                    });
                } catch (err: any) {
                    console.error(`[hhru] локальная ошибка "${vacancy.vacancyName}":`, err.message);
                    results.push({
                        vacancyName: vacancy.vacancyName,
                        hhAccountId: vacancy.hhAccountId,
                        hhAccountEmail: vacancy.hhAccountEmail,
                        success: false,
                        error: err.message,
                    });
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
        if (isRuntimeVacancyStopped(vacancy.vacancyId)) {
            console.log(`[hhru] «${vacancy.vacancyName}» приостановлена во время прохода — не отправляю в n8n`);
            continue;
        }
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
                results.push({
                    vacancyName: vacancy.vacancyName,
                    hhAccountId: vacancy.hhAccountId,
                    hhAccountEmail: vacancy.hhAccountEmail,
                    success: false,
                    error: `HTTP ${response.status}`,
                });
            } else {
                const data = await response.json() as VacancyN8nResult["data"];
                console.log(`[hhru] обработано: "${vacancy.vacancyName}"`);
                results.push({
                    vacancyName: vacancy.vacancyName,
                    hhAccountId: vacancy.hhAccountId,
                    hhAccountEmail: vacancy.hhAccountEmail,
                    success: true,
                    data,
                });
            }
        } catch (err: any) {
            console.error(`[hhru] ошибка отправки "${vacancy.vacancyName}":`, err);
            results.push({
                vacancyName: vacancy.vacancyName,
                hhAccountId: vacancy.hhAccountId,
                hhAccountEmail: vacancy.hhAccountEmail,
                success: false,
                error: err.message,
            });
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
