/**
 * Форматирование полного резюме HH в текст для ИИ.
 * Перенос ноды n8n «Собираем резюме для нейронки1».
 */

function val(value: any, fallback = "не указано"): string {
    if (value === null || value === undefined || value === "") return fallback;
    return String(value);
}

function boolText(value: any): string {
    if (value === true) return "да";
    if (value === false) return "нет";
    return "не указано";
}

function cleanHtml(html: any): string {
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
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim() || "не указано";
}

function names(arr: any): string {
    if (!Array.isArray(arr) || arr.length === 0) return "не указано";
    return arr.map((x) => x?.name).filter(Boolean).join(", ") || "не указано";
}

function formatSalary(salary: any): string {
    if (!salary) return "не указано";
    const { from, to, amount, currency = "" } = salary;
    if (amount) return `${amount} ${currency}`.trim();
    if (from && to) return `${from}–${to} ${currency}`.trim();
    if (from) return `от ${from} ${currency}`.trim();
    if (to) return `до ${to} ${currency}`.trim();
    return "не указано";
}

function formatExperienceMonths(totalExperience: any): string {
    const months = totalExperience?.months;
    if (!months && months !== 0) return "не указано";
    const years = Math.floor(months / 12);
    const rest = months % 12;
    if (years && rest) return `${years} г. ${rest} мес.`;
    if (years) return `${years} г.`;
    return `${rest} мес.`;
}

function formatRelocation(relocation: any): string {
    if (!relocation) return "не указано";
    return [
        `Готовность к переезду: ${val(relocation.type?.name)}`,
        `Города для переезда: ${names(relocation.area)}`,
    ].join("\n");
}

function formatLanguages(language: any): string {
    if (!Array.isArray(language) || language.length === 0) return "не указано";
    return language.map((l) => `${val(l.name)} — ${val(l.level?.name)}`).join(", ");
}

function formatEducationList(title: string, list: any): string {
    if (!Array.isArray(list) || list.length === 0) return `${title}: не указано`;
    const body = list
        .map((ed, i) =>
            `${i + 1}. ${val(ed.name)}\nОрганизация / факультет: ${val(ed.organization)}\nСпециальность / результат: ${val(ed.result)}\nГод окончания: ${val(ed.year)}`
        )
        .join("\n\n");
    return `${title}:\n${body}`;
}

function formatEducation(education: any): string {
    if (!education) return "не указано";
    return [
        `Уровень образования: ${val(education.level?.name)}`,
        formatEducationList("Основное образование", education.primary),
        formatEducationList("Дополнительное образование", education.additional),
    ].join("\n\n");
}

function formatExperience(experience: any): string {
    if (!Array.isArray(experience) || experience.length === 0) return "не указано";
    return experience
        .map((exp, i) => {
            const industries = Array.isArray(exp.industries)
                ? exp.industries.map((x: any) => x.name).filter(Boolean).join(", ")
                : "не указано";
            return `${i + 1}. ${val(exp.position)}\nКомпания: ${val(exp.company)}\nПериод: ${val(exp.start)} — ${val(exp.end, "по настоящее время")}\nГород / регион: ${val(exp.area?.name)}\nОтрасли: ${industries || "не указано"}\n\nОписание:\n${cleanHtml(exp.description)}`;
        })
        .join("\n\n");
}

/** Метаданные отклика, которые приходят из getNewResponses */
export interface ResumeMeta {
    vacancy_id: string;
    vacancy_name: string;
    negotiation_id: string;
}

/** Собирает большой текст резюме для ИИ */
export function formatResumeText(resume: any, meta: ResumeMeta): string {
    const fullName = [resume.last_name, resume.first_name, resume.middle_name].filter(Boolean).join(" ");
    const skillSet =
        Array.isArray(resume.skill_set) && resume.skill_set.length > 0 ? resume.skill_set.join(", ") : "не указано";

    return `
ПОЛНОЕ РЕЗЮМЕ КАНДИДАТА

1. ОСНОВНАЯ ИНФОРМАЦИЯ
ФИО: ${fullName || "не указано"}
Название резюме: ${val(resume.title)}
ID резюме: ${val(resume.id)}
Ссылка на резюме hh.ru: ${val(resume.alternate_url)}
Дата обновления резюме: ${val(resume.updated_at)}
Возраст: ${val(resume.age)}
Пол: ${val(resume.gender?.name)}
Город / регион: ${val(resume.area?.name)}

2. ЖЕЛАЕМЫЕ УСЛОВИЯ
Желаемая зарплата: ${formatSalary(resume.salary)}
Основная занятость: ${val(resume.employment?.name)}
Формат работы: ${names(resume.work_format)}
График: ${val(resume.schedule?.name)}
Готовность к переезду:
${formatRelocation(resume.relocation)}

3. ПРОФЕССИОНАЛЬНАЯ ИНФОРМАЦИЯ
Профессиональные роли: ${names(resume.professional_roles)}
Общий опыт: ${formatExperienceMonths(resume.total_experience)}

Ключевые навыки:
${skillSet}

О себе / дополнительная информация:
${cleanHtml(resume.skills)}

4. ОПЫТ РАБОТЫ
${formatExperience(resume.experience)}

5. ОБРАЗОВАНИЕ
${formatEducation(resume.education)}

6. ЯЗЫКИ
${formatLanguages(resume.language)}

7. ГРАЖДАНСТВО
Гражданство: ${names(resume.citizenship)}
Есть автомобиль: ${boolText(resume.has_vehicle)}

13. МЕТАДАННЫЕ ОТКЛИКА
ID вакансии: ${val(meta.vacancy_id)}
Название вакансии: ${val(meta.vacancy_name)}
ID отклика: ${val(meta.negotiation_id)}
`.trim();
}
