export type WorkflowMode = "questionnaire" | "chat_question";

/**
 * Сценарий после успешного анализа резюме.
 * Старые строки реестра не имеют колонки H, поэтому сохраняем совместимость:
 * вакансия по волонтёрским организациям уже работала через вопрос в HH,
 * остальные вакансии — через анкету.
 */
export function parseWorkflowMode(value: unknown, vacancyName = ""): WorkflowMode {
    const raw = String(value ?? "").trim().toLowerCase();
    if (["chat_question", "chat", "hh", "вопрос", "вопрос в hh", "вопрос в хх"].includes(raw)) {
        return "chat_question";
    }
    if (["questionnaire", "form", "анкета", "с анкетой"].includes(raw)) {
        return "questionnaire";
    }
    const name = String(vacancyName || "").toLowerCase().replace(/ё/g, "е");
    return name.includes("волонтерск") ? "chat_question" : "questionnaire";
}

export function workflowModeCell(mode: WorkflowMode): string {
    return mode === "chat_question" ? "вопрос в HH" : "анкета";
}
