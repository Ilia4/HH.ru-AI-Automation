/**
 * Сборка промпта для ИИ-оценки кандидата.
 * Перенос ноды n8n «Собираем prompt1».
 */

function stripHtml(html: any): string {
    if (!html) return "не указано";
    return String(html)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n")
        .replace(/<\/li>/gi, "\n")
        .replace(/<li>/gi, "- ")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim() || "не указано";
}

function names(arr: any): string {
    if (!Array.isArray(arr) || arr.length === 0) return "не указано";
    return arr.map((x) => x?.name).filter(Boolean).join(", ") || "не указано";
}

function salaryText(salary: any): string {
    if (!salary) return "не указано";
    const from = salary.from ? `от ${salary.from}` : "";
    const to = salary.to ? `до ${salary.to}` : "";
    const currency = salary.currency || "";
    const gross = salary.gross === true ? "до вычета налогов" : salary.gross === false ? "на руки" : "";
    return [from, to, currency, gross].filter(Boolean).join(" ") || "не указано";
}

export interface PromptCandidate {
    candidate_name: string;
    resume_title: string;
    resume_url: string;
    vacancy_id: string;
    vacancy_name: string;
    resume_text: string;
    candidate_city?: string;      // город кандidата (дословно из резюме)
    candidate_relocation?: string; // готовность к переезду
}

/**
 * Строит промпт. vacancy — объект из getVacancy, filter — доп. фильтры из таблицы.
 */
export function buildPrompt(
    vacancy: any,
    filter: string,
    candidate: PromptCandidate,
    options: { minScore?: number } = {},
): string {
    const minScore = Number.isFinite(options.minScore) ? Math.max(0, Math.min(10, Number(options.minScore))) : 7;
    const manualFrom = Math.max(0, minScore - 2);
    const vacancyDescription = stripHtml(vacancy?.description);
    const keySkills = names(vacancy?.key_skills);
    const professionalRoles = names(vacancy?.professional_roles);
    const workFormat = names(vacancy?.work_format);
    const workSchedule = names(vacancy?.work_schedule_by_days);

    return `
Ты — HR-ассистент для первичного анализа откликов кандидатов.

Твоя задача — оценить кандидата на вакансию по резюме и вернуть строго JSON.

ВАЖНО (СТРОГО СОБЛЮДАЙ):
- Резюме кандидата предоставлено ниже.
- Не отвечай, что резюме не предоставлено.
- ЗАПРЕЩЕНО придумывать факты, которых нет в резюме. Особенно НЕ ВЫДУМЫВАЙ город кандидата, компании, должности и цифры.
- Город кандидата и готовность к переезду бери ТОЛЬКО из блока «ФАКТЫ О КАНДИДАТЕ» ниже — дословно. Никакой другой город не упоминай.
- Не завышай оценку только из-за красивого текста.
- Смотри на реальный опыт, навыки, должности, обязанности, достижения, город, формат работы и дополнительные фильтры заказчика.

ФАКТЫ О КАНДИДАТЕ (используй дословно, не заменяй и не выдумывай):
Город кандидата: ${candidate.candidate_city || "не указано"}
Готовность к переезду: ${candidate.candidate_relocation || "не указано"}

ПРАВИЛО ПРО ГОРОД И ПЕРЕЕЗД:
- Если «Готовность к переезду» говорит, что кандидат готов/может переехать — другой город кандидата НЕ является стоп-фактором, НЕ считай это риском и НЕ снижай за это балл. Считай, что кандидат сможет работать в городе вакансии.
- Город считай минусом ТОЛЬКО если кандидат из другого города И явно НЕ готов к переезду.

ВАКАНСИЯ:
ID вакансии: ${vacancy?.id || candidate.vacancy_id || "не указано"}
Название вакансии: ${vacancy?.name || candidate.vacancy_name || "не указано"}
Компания: ${vacancy?.employer?.name || "не указано"}
Город вакансии: ${vacancy?.area?.name || "не указано"}
Зарплата: ${salaryText(vacancy?.salary)}
Требуемый опыт: ${vacancy?.experience?.name || "не указано"}
Формат работы: ${workFormat}
График: ${workSchedule}
Профессиональные роли: ${professionalRoles}
Ключевые навыки вакансии: ${keySkills}

ОПИСАНИЕ ВАКАНСИИ:
${vacancyDescription}

ДОПОЛНИТЕЛЬНЫЕ ФИЛЬТРЫ ОТ ЗАКАЗЧИКА:
${filter || "не указано"}

ПРАВИЛА ДОПОЛНИТЕЛЬНЫХ ФИЛЬТРОВ:
- Для каждого пронумерованного фильтра верни filter_results: number, matched и короткую причину.
- AUTO +: учитывай подтверждённое соответствие как плюс при базовой оценке.
- AUTO −: учитывай подтверждённое соответствие как минус при базовой оценке.
- FIXED: не меняй из-за него базовый score — система сама прибавит или вычтет указанные баллы после ответа.
- matched=true только когда резюме действительно подтверждает условие; отсутствие сведений не является совпадением.

ПОЛНОЕ РЕЗЮМЕ КАНДИДАТА:
${candidate.resume_text}

ПРАВИЛА ОЦЕНКИ:
Оцени кандидата по шкале от 0 до 10.

Ниже ${manualFrom}: Кандидат не подходит.
От ${manualFrom} до значения ниже ${minScore}: Кандидат спорный, нужна ручная проверка HR.
От ${minScore} и выше: Кандидат подходит.

ЖЁСТКИЕ ПРАВИЛА ДЛЯ STATUS:
- Если score меньше ${manualFrom} — status = "Отказ"
- Если score от ${manualFrom}, но меньше ${minScore} — status = "Ручная проверка"
- Если score равен ${minScore} или выше — status = "Подходит"

ВАЖНО:
- Status должен строго соответствовать score.
- Только один из трёх вариантов: "Подходит", "Ручная проверка", "Отказ".

ПРАВИЛА ДЛЯ AI_COMMENT:
- Пиши 2–4 предложения.
- Сначала укажи сильные стороны, потом риски или чего не хватает.
- Пиши понятно для HR, без воды, не придумывай факты.

ВЕРНИ СТРОГО JSON БЕЗ MARKDOWN И БЕЗ ТЕКСТА СНАРУЖИ.

Формат ответа:
{
  "resume_url": "${candidate.resume_url || "не указано"}",
  "ai_comment": "короткий комментарий по кандидату: почему поставлен такой балл, какие плюсы и минусы",
  "score": 0,
  "status": "Отказ",
  "filter_results": [
    { "number": 1, "matched": false, "reason": "почему условие подтверждено или не подтверждено" }
  ]
}
`.trim();
}
