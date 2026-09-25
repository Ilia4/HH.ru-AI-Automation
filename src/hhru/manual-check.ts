/**
 * Ветка B — ручная проверка кандидатов 5-6 баллов.
 * Перенос нод n8n: «Ищем ручные решения» → consider → match → «Готовим ручное действие» → действие.
 *
 * Логика: HR в листе «ИИ анализ резюме» руками меняет «Статус» кандидата с баллом 5-6
 * на «Отказ» или «Подходит». Бот находит такие строки, сопоставляет с откликами в стадии
 * «Подумать» на HH и выполняет действие:
 *   - «Отказ»    → discard_by_employer + шаблон «Отказ + Резюме»
 *   - «Подходит» → phone_interview      + шаблон «Успешно + Резюме»
 *
 * dryRun (по умолчанию true): только считает, что было бы сделано, без действий на HH.
 */
import { getNegotiation, extractActions, employerStage, sendCandidateMessageOnce, hasEmployerMessageText, doNegotiationAction, getConversationMessages, type HhNegotiation } from "./hh-api";
import { employerAlreadySent, shouldSkipSend, hasAnyDecision } from "./message-dedup";
import { isVacancyArchived, queueArchivedContact, vacancyLiveOverride } from "./archived-notify";
import {
    extractSpreadsheetId,
    readAnalysisRows,
    updateAnalysisStatus,
    readTemplates,
    findTemplate,
    fillTemplate,
    fillResumeSuccessTemplate,
} from "./sheets-analysis";
import { beginVacancyRun, canContinueVacancyRun } from "./vacancy-activity";

export interface ManualCheckResult {
    checked: boolean;
    processed_total: number;
    accepted_count: number;
    rejected_count: number;
    message: string;
}

interface ManualDecision {
    negotiation_id: string;
    resume_id: string;
    resume_url: string;
    score: number;
    status: string; // «Отказ» | «Подходит»
    ai_comment: string;
}

/** Парсит ссылку https://hh.ru/resume/<resume_id>?t=<negotiation_id> */
function parseResumeLink(link: string): { resume_id: string; negotiation_id: string } {
    const text = String(link || "");
    const resumeIdMatch = text.match(/resume\/([^?]+)/);
    const negotiationMatch = text.match(/[?&]t=([^&]+)/);
    return {
        resume_id: resumeIdMatch ? resumeIdMatch[1] : "",
        negotiation_id: negotiationMatch ? negotiationMatch[1] : "",
    };
}

function candidateName(n: HhNegotiation): string {
    return [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name].filter(Boolean).join(" ") || "Без имени";
}

// Ранг стадии отклика — чтобы двигать только вперёд, а не назад
const STAGE_RANK: Record<string, number> = {
    response: 1,        // Отклик
    consider: 2,        // Подумать
    phone_interview: 3, // Первичный контакт
    assessment: 3,      // Тестовое задание
    interview: 4,       // Собеседование
    offer: 5,           // Оффер
    hired: 6,           // Принят
};

// Архивная вакансия: HH больше не разрешает положительные переходы по воронке,
// но существующий чат остаётся доступен. Для неё отправляем анкету кандидатам
// со статусом «Подходит», не меняя текущую стадию на HH.
const QUESTIONNAIRE_WITHOUT_STAGE_VACANCY_IDS = new Set(["133959149"]);
/** -1 = отказ (терминальная), 0 = неизвестно, иначе ранг стадии */
function stageRank(state?: { id?: string; name?: string }): number {
    const id = String(state?.id || "");
    const name = String(state?.name || "");
    if (id.startsWith("discard") || name === "Отказ") return -1;
    return STAGE_RANK[id] ?? 0;
}

export interface ManualCheckInput {
    vacancyId: string;
    vacancyName: string;
    templatesUrl?: string | null;
}

export async function processManualDecisions(
    vacancy: ManualCheckInput,
    options: { dryRun?: boolean } = {}
): Promise<ManualCheckResult> {
    const dryRun = vacancyLiveOverride(vacancy.vacancyId) ? false : (options.dryRun !== false);
    const tag = dryRun ? "[manual:DRY]" : "[manual:LIVE]";
    const runToken = beginVacancyRun(vacancy.vacancyId);
    const stopped = (): ManualCheckResult => ({
        checked: false,
        processed_total: 0,
        accepted_count: 0,
        rejected_count: 0,
        message: "Вакансия приостановлена",
    });
    if (!canContinueVacancyRun(runToken)) return stopped();

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) {
        return { checked: false, processed_total: 0, accepted_count: 0, rejected_count: 0, message: "Нет templatesUrl" };
    }

    // 1. читаем лист «ИИ анализ резюме», ищем ручные решения HR
    const rows = await readAnalysisRows(spreadsheetId);

    // Если HR уже обработал кандидата непосредственно в HH, отражаем фактическую
    // стадию в существующем столбце «Статус». Сообщения и действия при этом не выполняются.
    if (!dryRun) {
        for (const row of rows) {
            if (!canContinueVacancyRun(runToken)) {
                console.log(`${tag} «${vacancy.vacancyName}» приостановлена — сверка стадий остановлена`);
                return stopped();
            }
            const currentStatus = String(row["Статус"] || "").trim();
            if (currentStatus !== "Ручная проверка") continue;

            const parsed = parseResumeLink(row["Ссылка на резюме"] || "");
            if (!parsed.negotiation_id) continue;

            let hh: HhNegotiation | null = null;
            try {
                hh = await getNegotiation(parsed.negotiation_id);
            } catch (e: any) {
                console.warn(`${tag} • не смог проверить ${parsed.negotiation_id}: ${e.message}`);
                continue;
            }
            if (!hh) continue;

            const hhStage = employerStage(hh);
            const stageId = String(hhStage.id || "");
            // «Отклик» и «Подумать» ещё требуют решения HR — их не меняем.
            if (stageId === "response" || stageId === "consider" || !stageId) continue;

            const actualStatus = String(hhStage.name || "").trim()
                || (stageId.startsWith("discard") ? "Отказ" : stageId);
            const rowNumber = Number(row.row_number);
            try {
                await updateAnalysisStatus(spreadsheetId, rowNumber, actualStatus);
                row["Статус"] = actualStatus;
                console.log(`${tag} • строка ${rowNumber}: фактический статус HH «${actualStatus}» записан без повторного сообщения`);
            } catch (e: any) {
                console.warn(`${tag} • не обновил статус строки ${rowNumber}: ${e.message}`);
            }
        }
    }

    const decisions: ManualDecision[] = [];
    for (const row of rows) {
        const scoreNum = Number(String(row["Балл"] || "").replace(",", "."));
        const status = String(row["Статус"] || "").trim();
        // любой кандидат с решением «Подходит»/«Отказ» (независимо от балла) — чтобы вытащить и застрявших ≥7
        const isHrDecision = status === "Отказ" || status === "Подходит";
        if (!isHrDecision) continue;

        const resumeUrl = row["Ссылка на резюме"] || "";
        const parsed = parseResumeLink(resumeUrl);
        if (!parsed.negotiation_id) continue;

        decisions.push({
            negotiation_id: parsed.negotiation_id,
            resume_id: parsed.resume_id,
            resume_url: resumeUrl,
            score: scoreNum,
            status,
            ai_comment: row["Комментарии ИИ"] || "",
        });
    }

    if (decisions.length === 0) {
        console.log(`${tag} ручных решений нет`);
        return { checked: true, processed_total: 0, accepted_count: 0, rejected_count: 0, message: "Ручных решений для обработки нет" };
    }

    console.log(`${tag} найдено ручных решений: ${decisions.length}`);

    // шаблоны автоответов (нужны только для реальной отправки)
    const templates = dryRun ? [] : await readTemplates(spreadsheetId);

    let accepted = 0;
    let rejected = 0;
    let processed = 0;

    for (const decision of decisions) {
        if (!canContinueVacancyRun(runToken)) {
            console.log(`${tag} «${vacancy.vacancyName}» приостановлена — оставшиеся решения не исполняются`);
            break;
        }
        // берём отклик напрямую по id — в любой стадии
        let hh: HhNegotiation | null = null;
        try {
            hh = await getNegotiation(decision.negotiation_id);
        } catch (e: any) {
            console.warn(`${tag} • ошибка чтения ${decision.negotiation_id}: ${e.message}`);
            continue;
        }
        if (!hh) {
            console.log(`${tag} • ${decision.negotiation_id} — отклик не найден на HH, пропуск`);
            continue;
        }

        const name = candidateName(hh);
        const actions = extractActions(hh);
        // Стадию берём из воронки работодателя: hh.state залипает на «Отклик»,
        // из-за чего бот повторял перевод уже переведённых кандидатов каждый час.
        const hhStage = employerStage(hh);
        const stage = hhStage.name || "?";
        const rank = stageRank(hhStage);

        // ДЕДУП по смыслу: читаем чат один раз. Если там уже есть сообщение того типа,
        // что мы собираемся отправить (прислал бот ИЛИ руководитель вручную) — не дублируем.
        const chatMsgs = hh.messages_url ? await getConversationMessages(hh.messages_url).catch(() => []) : [];
        if (!canContinueVacancyRun(runToken)) {
            console.log(`${tag} • ${name}: вакансия приостановлена — действие не выполняется`);
            break;
        }

        // Архивная вакансия: любое действие/отправка → 403 invalid_vacancy. Не пытаемся.
        // В список «написать вручную» берём только тех, с кем ещё не связывались.
        if (await isVacancyArchived(vacancy.vacancyId)) {
            if (hasAnyDecision(chatMsgs)) {
                console.log(`${tag} • ${name}: архив, но контакт уже был — пропуск`);
            } else {
                queueArchivedContact(vacancy.vacancyId, vacancy.vacancyName, { name, negotiationId: decision.negotiation_id, link: decision.resume_url });
                console.log(`${tag} • ${name}: архив, не связывались — в список на ручную отправку`);
            }
            continue;
        }

        if (decision.status === "Отказ") {
            // уже отклонён — не трогаем
            if (rank === -1) {
                console.log(`${tag} • ${name}: уже отказано — пропуск`);
                continue;
            }
            if (!actions.action_discard_url) {
                console.log(`${tag} • ${name}: отказ недоступен (стадия «${stage}») — пропуск`);
                continue;
            }
            console.log(`${tag} • ${name} → ОТКАЗ (из стадии «${stage}»)`);
            if (!dryRun && canContinueVacancyRun(runToken)) {
                const tpl = findTemplate(templates, "Отказ", "Резюме");
                const msg = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
                // Отказ уже был в чате (любым текстом, ботом или вручную) → двигаем стадию,
                // но письмо повторно НЕ шлём.
                const already = employerAlreadySent(chatMsgs, "reject");
                if (already) console.log(`${tag} • ${name}: отказ уже был в чате — только меняю стадию, письмо не дублирую`);
                await doNegotiationAction(actions.action_discard_url, actions.action_discard_method, already ? undefined : (msg || undefined));
            }
            rejected++;
            processed++;
        } else if (decision.status === "Подходит") {
            // переводим в «Первичный контакт» только если кандидат ещё раньше него (Отклик/Подумать)
            const PHONE_RANK = STAGE_RANK.phone_interview;
            if (rank >= PHONE_RANK) {
                console.log(`${tag} • ${name}: уже в стадии «${stage}» (не раньше первичного контакта) — не двигаю назад, пропуск`);
                continue;
            }
            if (rank === -1) {
                console.log(`${tag} • ${name}: кандидат в отказе — пропуск`);
                continue;
            }
            // Дедупликация ниже проверяет именно шаблон приглашения.
            // Сообщения встроенного ИИ-помощника HH больше не блокируют действие HR.
            if (!actions.action_phone_interview_url) {
                if (QUESTIONNAIRE_WITHOUT_STAGE_VACANCY_IDS.has(vacancy.vacancyId)) {
                    if (dryRun) {
                        console.log(`${tag} • ${name}: отправил бы анкету без смены стадии «${stage}»`);
                        accepted++;
                        processed++;
                        continue;
                    }

                    const tpl = findTemplate(templates, "Успешно", "Резюме");
                    const msg = tpl
                        ? fillResumeSuccessTemplate(tpl.text, name, vacancy.vacancyName, vacancy.vacancyId)
                        : "";
                    if (!msg || !hh.messages_url) {
                        console.log(`${tag} • ${name}: нет шаблона анкеты или messages_url — пропуск`);
                        continue;
                    }

                    const sk = shouldSkipSend(chatMsgs, "anketa_invite");
                    if (sk.skip) {
                        console.log(`${tag} • ${name}: не шлю приглашение-анкету (${sk.reason})`);
                        continue;
                    }
                    if (!canContinueVacancyRun(runToken)) break;
                    let sent = false;
                    try {
                        sent = await sendCandidateMessageOnce(hh.messages_url, msg);
                    } catch (e: any) {
                        console.warn(`${tag} • ${name}: ошибка отправки анкеты: ${e.message}`);
                        continue;
                    }
                    if (sent) {
                        console.log(`${tag} • ${name}: анкета отправлена без смены стадии «${stage}»`);
                        accepted++;
                        processed++;
                    } else {
                        console.log(`${tag} • ${name}: анкета уже отправлялась — повтор не нужен`);
                    }
                    continue;
                }
                console.log(`${tag} • ${name}: первичный контакт недоступен (стадия «${stage}») — пропуск`);
                continue;
            }
            console.log(`${tag} • ${name} → ПОДХОДИТ, первичный контакт (из стадии «${stage}»)`);
            if (!dryRun && canContinueVacancyRun(runToken)) {
                const tpl = findTemplate(templates, "Успешно", "Резюме");
                const msg = tpl
                    ? fillResumeSuccessTemplate(tpl.text, name, vacancy.vacancyName, vacancy.vacancyId)
                    : "";
                if (msg && hh.messages_url) {
                    const sk = shouldSkipSend(chatMsgs, "anketa_invite");
                    if (sk.skip) {
                        console.log(`${tag} • ${name}: не шлю приглашение-анкету (${sk.reason}) — стадию всё равно двигаю`);
                    } else {
                        await sendCandidateMessageOnce(hh.messages_url, msg);
                    }
                }
                await doNegotiationAction(actions.action_phone_interview_url, actions.action_phone_interview_method);
            }
            accepted++;
            processed++;
        }
    }

    return {
        checked: true,
        processed_total: processed,
        accepted_count: accepted,
        rejected_count: rejected,
        message: dryRun
            ? `Ручная проверка (dry-run): принято ${accepted}, отказ ${rejected}`
            : `Ручные решения обработаны: принято ${accepted}, отказ ${rejected}`,
    };
}
