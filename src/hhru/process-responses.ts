/**
 * Оркестратор обработки откликов по вакансии — замена n8n-воркфлоу.
 * Ветка A (новые отклики): получить → оценить ИИ → записать в таблицу → (опц.) действие на HH.
 *
 * dryRun (по умолчанию true): НЕ шлёт сообщения кандидатам и НЕ меняет статусы на HH,
 * только оценивает, пишет в лист «ИИ анализ резюме» и считает статистику.
 */
import {
    getAllNewResponses,
    getAllConsiderResponses,
    getResume,
    getVacancy,
    extractActions,
    sendCandidateMessageOnce,
    hasEmployerMessageText,
    doNegotiationAction,
    type HhNegotiation,
} from "./hh-api";
import { formatResumeText } from "./resume-format";
import { buildPrompt } from "./prompt-builder";
import { scoreCandidate } from "./ai-scorer";
import {
    extractSpreadsheetId,
    readFilters,
    readFilterSettings,
    formatFiltersForAi,
    upsertAnalysis,
    appendAnalysis,
    readAnalysisRowsStrict,
    readTemplates,
    findTemplate,
    fillTemplate,
    fillResumeSuccessTemplate,
    type AutoReplyTemplate,
} from "./sheets-analysis";
import { processManualDecisions } from "./manual-check";
import { beginVacancyRun, canContinueVacancyRun } from "./vacancy-activity";

export interface ProcessVacancyInput {
    vacancyId: string;
    vacancyName: string;
    templatesUrl?: string | null;
}

export interface ProcessOptions {
    dryRun?: boolean;
}

/** Структура ответа — идентична той, что возвращал n8n */
export interface ProcessResult {
    vacancy_id: string;
    vacancy_name: string;
    new_responses: {
        has_new_responses: boolean;
        total: number;
        passed_count: number;
        manual_count: number;
        failed_count: number;
        message: string;
        text: string;
    };
    manual_check: {
        checked: boolean;
        processed_total: number;
        accepted_count: number;
        rejected_count: number;
        message: string;
    };
    consider_backfill: {
        found_untracked: number;
        selected: number;
        processed: number;
        passed_count: number;
        manual_count: number;
        failed_count: number;
    };
}

function emptyManualCheck() {
    return { checked: false, processed_total: 0, accepted_count: 0, rejected_count: 0, message: "Ручная проверка не выполнялась" };
}

function stoppedProcessResult(vacancy: ProcessVacancyInput, message = "Вакансия приостановлена"): ProcessResult {
    return {
        vacancy_id: vacancy.vacancyId,
        vacancy_name: vacancy.vacancyName,
        new_responses: {
            has_new_responses: false,
            total: 0,
            passed_count: 0,
            manual_count: 0,
            failed_count: 0,
            message,
            text: "",
        },
        manual_check: emptyManualCheck(),
        consider_backfill: {
            found_untracked: 0,
            selected: 0,
            processed: 0,
            passed_count: 0,
            manual_count: 0,
            failed_count: 0,
        },
    };
}

/** Форматирует ISO-дату в «ДД.ММ.ГГГГ ЧЧ:ММ» по Москве */
function formatMoscowDate(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
    }).format(d).replace(",", "");
}

function candidateName(n: HhNegotiation): string {
    return (
        [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name].filter(Boolean).join(" ") ||
        n.resume?.title ||
        "Без имени"
    );
}

function negotiationIdFromAnalysisRow(row: Record<string, any>): string {
    const link = String(row["Ссылка на резюме"] || "");
    return link.match(/[?&]t=([^&]+)/)?.[1] || "";
}

/** resume_id из ссылки вида https://hh.ru/resume/<resume_id>?t=<negotiation_id> */
function resumeIdFromAnalysisRow(row: Record<string, any>): string {
    const link = String(row["Ссылка на резюме"] || "");
    return link.match(/resume\/([^?&/]+)/)?.[1] || "";
}

function considerBackfillEnabled(vacancyId: string): boolean {
    const configured = String(process.env.HHRU_CONSIDER_BACKFILL_VACANCY_IDS || "");
    const ids = configured.split(",").map((id) => id.trim()).filter(Boolean);
    return ids.includes("*") || ids.includes(vacancyId);
}

function considerBackfillBatchSize(): number {
    const parsed = Number(process.env.HHRU_CONSIDER_BACKFILL_BATCH_SIZE || 10);
    if (!Number.isFinite(parsed)) return 10;
    return Math.max(1, Math.min(50, Math.floor(parsed)));
}

export async function processVacancyResponses(
    vacancy: ProcessVacancyInput,
    options: ProcessOptions = {}
): Promise<ProcessResult> {
    const dryRun = options.dryRun !== false; // по умолчанию true
    const tag = dryRun ? "[process:DRY]" : "[process:LIVE]";
    const runToken = beginVacancyRun(vacancy.vacancyId);

    if (!canContinueVacancyRun(runToken)) {
        console.log(`${tag} вакансия "${vacancy.vacancyName}" приостановлена — обработка не запущена`);
        return stoppedProcessResult(vacancy);
    }

    console.log(`${tag} вакансия "${vacancy.vacancyName}" (${vacancy.vacancyId})`);

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");

    // ветка B (ручная проверка) — запускается ПОСЛЕ обработки новых откликов
    const runManualCheck = async () => {
        if (!canContinueVacancyRun(runToken)) return emptyManualCheck();
        try {
            return await processManualDecisions(vacancy, { dryRun });
        } catch (err: any) {
            console.error(`${tag} ошибка ручной проверки: ${err.message}`);
            return emptyManualCheck();
        }
    };

    const newResponses = await getAllNewResponses(vacancy.vacancyId);
    if (!canContinueVacancyRun(runToken)) {
        console.log(`${tag} «${vacancy.vacancyName}» остановлена после чтения откликов`);
        return stoppedProcessResult(vacancy);
    }
    const analysisRows = spreadsheetId ? await readAnalysisRowsStrict(spreadsheetId) : [];
    const analyzedIds = new Set(analysisRows.map(negotiationIdFromAnalysisRow).filter(Boolean));

    let considerFoundUntracked = 0;
    let considerBackfill: HhNegotiation[] = [];
    if (spreadsheetId && considerBackfillEnabled(vacancy.vacancyId)) {
        try {
            const considerResponses = await getAllConsiderResponses(vacancy.vacancyId);
            const untracked = considerResponses.filter((item) => item.id && !analyzedIds.has(String(item.id)));
            considerFoundUntracked = untracked.length;
            considerBackfill = untracked.slice(0, considerBackfillBatchSize());
            console.log(`${tag} «Подумать»: всего ${considerResponses.length}, без строки в таблице ${untracked.length}, выбрано ${considerBackfill.length}`);
        } catch (err: any) {
            console.error(`${tag} не смог прочитать стадию «Подумать»: ${err.message}`);
        }
    }

    const allItems: { negotiation: HhNegotiation; source: "response" | "consider" }[] = [
        ...newResponses.map((negotiation) => ({ negotiation, source: "response" as const })),
        ...considerBackfill.map((negotiation) => ({ negotiation, source: "consider" as const })),
    ];

    // Дедуп по резюме: кандидат мог откликнуться повторно (например, вакансию
    // перепубликовали новым id). Отклик новый, но человек уже оценивался по этой
    // же таблице — иначе он получит второе письмо и вторую строку в анализе.
    const analyzedResumeIds = new Set(analysisRows.map(resumeIdFromAnalysisRow).filter(Boolean));
    let duplicateSkipped = 0;
    const workItems = allItems.filter(({ negotiation }) => {
        const resumeId = String(negotiation.resume?.id || "");
        if (resumeId && analyzedResumeIds.has(resumeId)) {
            duplicateSkipped++;
            console.log(`${tag} • ${candidateName(negotiation)}: резюме уже оценивалось ранее — пропуск повторного отклика`);
            return false;
        }
        return true;
    });
    if (duplicateSkipped > 0) {
        console.log(`${tag} повторных откликов пропущено: ${duplicateSkipped} из ${allItems.length}`);
    }

    if (workItems.length === 0) {
        console.log(`${tag} новых откликов и необработанных кандидатов «Подумать» нет`);
        const manualCheck = await runManualCheck();
        return {
            vacancy_id: vacancy.vacancyId,
            vacancy_name: vacancy.vacancyName,
            new_responses: {
                has_new_responses: false,
                total: 0,
                passed_count: 0,
                manual_count: 0,
                failed_count: 0,
                message: "Новых откликов нет",
                text: "",
            },
            manual_check: manualCheck,
            consider_backfill: {
                found_untracked: considerFoundUntracked,
                selected: 0,
                processed: 0,
                passed_count: 0,
                manual_count: 0,
                failed_count: 0,
            },
        };
    }
    if (!canContinueVacancyRun(runToken)) return stoppedProcessResult(vacancy);
    // фильтры + описание вакансии тянем один раз
    const filterSettings = spreadsheetId
        ? await readFilterSettings(spreadsheetId)
        : { filters: [], minScore: 7 };
    const filter = formatFiltersForAi(filterSettings.filters);
    let vacancyData: any = {};
    try {
        vacancyData = await getVacancy(vacancy.vacancyId);
    } catch (err: any) {
        console.warn(`${tag} не смог получить описание вакансии: ${err.message}`);
    }
    if (!canContinueVacancyRun(runToken)) return stoppedProcessResult(vacancy);

    let templates: AutoReplyTemplate[] = [];
    if (!dryRun && spreadsheetId) {
        templates = await readTemplates(spreadsheetId);
    }

    let newPassed = 0;
    let newManual = 0;
    let newFailed = 0;
    let backfillPassed = 0;
    let backfillManual = 0;
    let backfillFailed = 0;
    let backfillProcessed = 0;
    let stoppedDuringRun = false;
    const lines: string[] = [];

    for (const item of workItems) {
        if (!canContinueVacancyRun(runToken)) {
            stoppedDuringRun = true;
            console.log(`${tag} «${vacancy.vacancyName}» приостановлена — оставшиеся кандидаты не обрабатываются`);
            break;
        }
        const r = item.negotiation;
        const source = item.source;
        const name = candidateName(r);
        try {
            if (!r.resume?.id) {
                console.warn(`${tag} пропуск отклика ${r.id}: HH не вернул resume.id`);
                continue;
            }

            const resume = await getResume(r.resume.id, r.id, vacancy.vacancyId);
            const resumeText = formatResumeText(resume, {
                vacancy_id: vacancy.vacancyId,
                vacancy_name: vacancy.vacancyName,
                negotiation_id: r.id,
            });
            const prompt = buildPrompt(vacancyData, filter, {
                candidate_name: name,
                resume_title: resume.title || "",
                resume_url: resume.alternate_url || "",
                vacancy_id: vacancy.vacancyId,
                vacancy_name: vacancy.vacancyName,
                resume_text: resumeText,
                candidate_city: resume.area?.name || "",
                candidate_relocation: resume.relocation?.type?.name || "",
            }, { minScore: filterSettings.minScore });

            const ai = await scoreCandidate(prompt);
            // ИИ-запрос мог уже выполняться в момент нажатия паузы. Его результат
            // после паузы не записываем и никаких действий по кандидату не делаем.
            if (!canContinueVacancyRun(runToken)) {
                stoppedDuringRun = true;
                console.log(`${tag} • ${name}: вакансия приостановлена во время анализа — результат отброшен`);
                break;
            }
            const baseScore = ai.score === "" ? 0 : ai.score;
            let fixedAdjustment = 0;
            const applied: string[] = [];
            for (let i = 0; i < filterSettings.filters.length; i++) {
                const rule = filterSettings.filters[i];
                if (rule.mode !== "fixed") continue;
                const match = ai.filter_results.find((result) => result.number === i + 1);
                if (!match?.matched) continue;
                const points = Number(rule.points || 0);
                fixedAdjustment += points;
                applied.push(`${points >= 0 ? "+" : ""}${points}: ${rule.text}`);
            }
            const score = Math.round(Math.max(0, Math.min(10, baseScore + fixedAdjustment)) * 10) / 10;
            const manualFrom = Math.max(0, filterSettings.minScore - 2);
            const finalStatus = score >= filterSettings.minScore
                ? "Подходит"
                : score >= manualFrom ? "Ручная проверка" : "Отказ";
            const aiComment = applied.length
                ? `${ai.ai_comment} Корректировка по фиксированным фильтрам: ${applied.join("; ")}.`
                : ai.ai_comment;
            const resumeLink = `https://hh.ru/resume/${r.resume.id}?t=${r.id}`;
            const analysisData = {
                resume_url: resumeLink,
                ai_comment: aiComment,
                score,
                status: finalStatus,
                processed_date: formatMoscowDate(new Date().toISOString()),
                fio: name,
            };

            if (spreadsheetId) {
                try {
                    if (source === "consider") {
                        await appendAnalysis(spreadsheetId, analysisData);
                    } else {
                        await upsertAnalysis(spreadsheetId, analysisData, r.id);
                    }
                    analyzedIds.add(String(r.id));
                } catch (e: any) {
                    console.warn(`${tag} не записал в таблицу для "${name}": ${e.message}`);
                    continue;
                }
            }

            if (!canContinueVacancyRun(runToken)) {
                stoppedDuringRun = true;
                console.log(`${tag} • ${name}: вакансия приостановлена — действие на HH не выполняется`);
                break;
            }

            const actions = extractActions(r);
            let bucket: "passed" | "manual" | "failed";
            if (score < manualFrom) bucket = "failed";
            else if (score < filterSettings.minScore) bucket = "manual";
            else bucket = "passed";

            if (source === "response") {
                if (bucket === "passed") newPassed++;
                else if (bucket === "manual") newManual++;
                else newFailed++;
            } else {
                backfillProcessed++;
                if (bucket === "passed") backfillPassed++;
                else if (bucket === "manual") backfillManual++;
                else backfillFailed++;
            }

            const sourceLabel = source === "consider" ? " [из «Подумать»]" : "";
            console.log(`${tag} • ${name} — ${score} → ${finalStatus}${sourceLabel}`);
            lines.push(`- ${name} — ${score} баллов (${finalStatus})${sourceLabel}`);

            if (!dryRun && canContinueVacancyRun(runToken)) {
                if (bucket === "passed") {
                    if (!actions.action_phone_interview_url) {
                        console.warn(`${tag} ⚠ "${name}": нет action_phone_interview — не перевёл в «Первичный контакт»`);
                    } else {
                        const tpl = findTemplate(templates, "Успешно", "Резюме");
                        const msg = tpl
                            ? fillResumeSuccessTemplate(tpl.text, name, vacancy.vacancyName, vacancy.vacancyId)
                            : "";
                        if (!msg || !r.messages_url) {
                            console.warn(`${tag} ⚠ "${name}": нет шаблона или messages_url — приглашение и перевод пропущены`);
                        } else {
                            await sendCandidateMessageOnce(r.messages_url, msg);
                            await doNegotiationAction(actions.action_phone_interview_url, actions.action_phone_interview_method);
                        }
                    }
                } else if (bucket === "manual") {
                    if (source === "consider") {
                        console.log(`${tag} • ${name}: уже в «Подумать», ждём решения HR в таблице`);
                    } else if (!actions.action_consider_url) {
                        console.warn(`${tag} ⚠ "${name}": нет action_consider — не перевёл в «Подумать»`);
                    } else {
                        await doNegotiationAction(actions.action_consider_url, actions.action_consider_method);
                    }
                } else {
                    if (!actions.action_discard_url) {
                        console.warn(`${tag} ⚠ "${name}": нет action_discard — не отклонил`);
                    } else {
                        const tpl = findTemplate(templates, "Отказ", "Резюме");
                        const msg = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
                        const already = msg && r.messages_url
                            ? await hasEmployerMessageText(r.messages_url, msg)
                            : false;
                        await doNegotiationAction(
                            actions.action_discard_url,
                            actions.action_discard_method,
                            already ? undefined : (msg || undefined),
                        );
                    }
                }
            }
        } catch (err: any) {
            console.error(`${tag} ошибка по кандидату "${name}": ${err.message}`);
        }
    }

    // ветка B — ручная проверка (5-6 из таблицы) сразу после обработки новых откликов
    const manualCheck = canContinueVacancyRun(runToken) ? await runManualCheck() : emptyManualCheck();

    const total = newResponses.length;
    const text = [
        `Статистика по вакансии: ${vacancy.vacancyName}`,
        `Новых откликов: ${total}`,
        `Восстановлено из «Подумать»: ${backfillProcessed} из ${considerFoundUntracked}`,
        `Новые — прошли: ${newPassed}, на проверку: ${newManual}, отказ: ${newFailed}`,
        `Подумать — прошли: ${backfillPassed}, на проверку: ${backfillManual}, отказ: ${backfillFailed}`,
        "",
        ...lines,
    ].join("\n");

    return {
        vacancy_id: vacancy.vacancyId,
        vacancy_name: vacancy.vacancyName,
        new_responses: {
            has_new_responses: total > 0,
            total,
            passed_count: newPassed,
            manual_count: newManual,
            failed_count: newFailed,
            message: stoppedDuringRun
                ? "Обработка прервана: вакансия приостановлена"
                : total > 0
                ? (dryRun ? "Отклики оценены (dry-run, без действий на HH)" : "Новые отклики обработаны")
                : "Новых откликов нет; обработана очередь «Подумать»",
            text,
        },
        manual_check: manualCheck,
        consider_backfill: {
            found_untracked: considerFoundUntracked,
            selected: considerBackfill.length,
            processed: backfillProcessed,
            passed_count: backfillPassed,
            manual_count: backfillManual,
            failed_count: backfillFailed,
        },
    };
}
