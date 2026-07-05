/**
 * Оркестратор обработки откликов по вакансии — замена n8n-воркфлоу.
 * Ветка A (новые отклики): получить → оценить ИИ → записать в таблицу → (опц.) действие на HH.
 *
 * dryRun (по умолчанию true): НЕ шлёт сообщения кандидатам и НЕ меняет статусы на HH,
 * только оценивает, пишет в лист «ИИ анализ резюме» и считает статистику.
 */
import {
    getNewResponses,
    getResume,
    getVacancy,
    extractActions,
    sendCandidateMessageOnce,
    hasEmployerMessage,
    doNegotiationAction,
    type HhNegotiation,
} from "./hh-api";
import { formatResumeText } from "./resume-format";
import { buildPrompt } from "./prompt-builder";
import { scoreCandidate } from "./ai-scorer";
import {
    extractSpreadsheetId,
    readFilters,
    upsertAnalysis,
    readTemplates,
    findTemplate,
    fillTemplate,
    type AutoReplyTemplate,
} from "./sheets-analysis";
import { processManualDecisions } from "./manual-check";

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
}

function emptyManualCheck() {
    return { checked: false, processed_total: 0, accepted_count: 0, rejected_count: 0, message: "Ручная проверка не выполнялась" };
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

export async function processVacancyResponses(
    vacancy: ProcessVacancyInput,
    options: ProcessOptions = {}
): Promise<ProcessResult> {
    const dryRun = options.dryRun !== false; // по умолчанию true
    const tag = dryRun ? "[process:DRY]" : "[process:LIVE]";

    console.log(`${tag} вакансия "${vacancy.vacancyName}" (${vacancy.vacancyId})`);

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");

    // ветка B (ручная проверка) — запускается ПОСЛЕ обработки новых откликов
    const runManualCheck = async () => {
        try {
            return await processManualDecisions(vacancy, { dryRun });
        } catch (err: any) {
            console.error(`${tag} ошибка ручной проверки: ${err.message}`);
            return emptyManualCheck();
        }
    };

    const responses = await getNewResponses(vacancy.vacancyId);
    if (responses.length === 0) {
        console.log(`${tag} новых откликов нет`);
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
        };
    }

    // фильтры + описание вакансии тянем один раз
    const { filter } = spreadsheetId ? await readFilters(spreadsheetId) : { filter: "" };
    let vacancyData: any = {};
    try {
        vacancyData = await getVacancy(vacancy.vacancyId);
    } catch (err: any) {
        console.warn(`${tag} не смог получить описание вакансии: ${err.message}`);
    }

    let templates: AutoReplyTemplate[] = [];
    if (!dryRun && spreadsheetId) {
        templates = await readTemplates(spreadsheetId);
    }

    let passed = 0;
    let manual = 0;
    let failed = 0;
    const lines: string[] = [];

    for (const r of responses) {
        const name = candidateName(r);
        try {
            const resume = await getResume(r.resume!.id!, r.id, vacancy.vacancyId);
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
            });

            const ai = await scoreCandidate(prompt);
            const score = ai.score === "" ? 0 : ai.score;

            // запись в таблицу «ИИ анализ резюме».
            // Ссылку пишем с ?t=<negotiation_id>, чтобы ветка B потом сопоставила решение HR с откликом.
            const resumeLink = r.resume?.id
                ? `https://hh.ru/resume/${r.resume.id}?t=${r.id}`
                : resume.alternate_url || "";
            if (spreadsheetId) {
                try {
                    await upsertAnalysis(spreadsheetId, {
                        resume_url: resumeLink,
                        ai_comment: ai.ai_comment,
                        score: ai.score,
                        status: ai.status,
                        processed_date: formatMoscowDate(new Date().toISOString()),
                    }, r.id);
                } catch (e: any) {
                    console.warn(`${tag} не записал в таблицу для "${name}": ${e.message}`);
                }
            }

            // классификация по баллу (как Switch в n8n)
            const actions = extractActions(r);
            let bucket: "passed" | "manual" | "failed";
            if (score < 5) bucket = "failed";
            else if (score < 7) bucket = "manual";
            else bucket = "passed";

            if (bucket === "passed") passed++;
            else if (bucket === "manual") manual++;
            else failed++;

            console.log(`${tag} • ${name} — ${score} → ${ai.status}`);
            lines.push(`- ${name} — ${score} баллов (${ai.status})`);

            // реальные действия на HH только если НЕ dry-run
            if (!dryRun) {
                if (bucket === "passed") {
                    // прошёл (>=7): перевод в «Первичный контакт» + приглашение (тестовое)
                    if (!actions.action_phone_interview_url) {
                        console.warn(`${tag} ⚠ "${name}": нет action_phone_interview — не перевёл в «Первичный контакт»`);
                    } else {
                        const tpl = findTemplate(templates, "Успешно", "Резюме");
                        const msg = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
                        if (msg && r.messages_url) await sendCandidateMessageOnce(r.messages_url, msg);
                        await doNegotiationAction(actions.action_phone_interview_url, actions.action_phone_interview_method);
                    }
                } else if (bucket === "manual") {
                    // 5-6: перевод в «Подумать» БЕЗ сообщения — ждём ручного решения HR (ветка B)
                    if (!actions.action_consider_url) {
                        console.warn(`${tag} ⚠ "${name}": нет action_consider — не перевёл в «Подумать»`);
                    } else {
                        await doNegotiationAction(actions.action_consider_url, actions.action_consider_method);
                    }
                } else {
                    // отказ (<5): discard + сообщение об отказе (без дубля)
                    if (!actions.action_discard_url) {
                        console.warn(`${tag} ⚠ "${name}": нет action_discard — не отклонил`);
                    } else {
                        const tpl = findTemplate(templates, "Отказ", "Резюме");
                        const msg = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
                        const already = r.messages_url ? await hasEmployerMessage(r.messages_url) : false;
                        await doNegotiationAction(actions.action_discard_url, actions.action_discard_method, already ? undefined : (msg || undefined));
                    }
                }
            }
        } catch (err: any) {
            console.error(`${tag} ошибка по кандидату "${name}": ${err.message}`);
        }
    }

    // ветка B — ручная проверка (5-6 из таблицы) сразу после обработки новых откликов
    const manualCheck = await runManualCheck();

    const total = responses.length;
    const text = [
        `Статистика по вакансии: ${vacancy.vacancyName}`,
        ``,
        `Всего откликов: ${total}`,
        `Прошли: ${passed}`,
        `На проверку: ${manual}`,
        `Отказ: ${failed}`,
        ``,
        ...lines,
    ].join("\n");

    return {
        vacancy_id: vacancy.vacancyId,
        vacancy_name: vacancy.vacancyName,
        new_responses: {
            has_new_responses: true,
            total,
            passed_count: passed,
            manual_count: manual,
            failed_count: failed,
            message: dryRun ? "Отклики оценены (dry-run, без действий на HH)" : "Новые отклики обработаны",
            text,
        },
        manual_check: manualCheck,
    };
}
