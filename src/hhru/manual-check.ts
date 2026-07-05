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
import { getNegotiation, extractActions, sendCandidateMessageOnce, hasEmployerMessage, doNegotiationAction, type HhNegotiation } from "./hh-api";
import {
    extractSpreadsheetId,
    readAnalysisRows,
    readTemplates,
    findTemplate,
    fillTemplate,
} from "./sheets-analysis";

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
    const dryRun = options.dryRun !== false;
    const tag = dryRun ? "[manual:DRY]" : "[manual:LIVE]";

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl || "");
    if (!spreadsheetId) {
        return { checked: false, processed_total: 0, accepted_count: 0, rejected_count: 0, message: "Нет templatesUrl" };
    }

    // 1. читаем лист «ИИ анализ резюме», ищем ручные решения HR
    const rows = await readAnalysisRows(spreadsheetId);
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
        // берём отклик напрямую по id — в любой стадии
        const hh = await getNegotiation(decision.negotiation_id);
        if (!hh) {
            console.log(`${tag} • ${decision.negotiation_id} — отклик не найден на HH, пропуск`);
            continue;
        }

        const name = candidateName(hh);
        const actions = extractActions(hh);
        const stage = hh.state?.name || "?";
        const rank = stageRank(hh.state);

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
            if (!dryRun) {
                const tpl = findTemplate(templates, "Отказ", "Резюме");
                const msg = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
                const already = hh.messages_url ? await hasEmployerMessage(hh.messages_url) : false;
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
            // Идемпотентность: если мы уже написали кандидату (значит уже перевели в первичный контакт),
            // второй раз не трогаем — иначе каждый прогон переобрабатывает одних и тех же (state=response у HH).
            if (hh.messages_url && await hasEmployerMessage(hh.messages_url)) {
                console.log(`${tag} • ${name}: уже написано ранее — пропуск`);
                continue;
            }
            if (!actions.action_phone_interview_url) {
                console.log(`${tag} • ${name}: первичный контакт недоступен (стадия «${stage}») — пропуск`);
                continue;
            }
            console.log(`${tag} • ${name} → ПОДХОДИТ, первичный контакт (из стадии «${stage}»)`);
            if (!dryRun) {
                const tpl = findTemplate(templates, "Успешно", "Резюме");
                const msg = tpl ? fillTemplate(tpl.text, name, vacancy.vacancyName) : "";
                if (msg && hh.messages_url) await sendCandidateMessageOnce(hh.messages_url, msg);
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
