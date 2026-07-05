import { askAi } from "../hhru/ai-scorer";
import type { VacancyQaItem } from "./vacancies";

export interface AiQaDecision {
    decision: "answer" | "escalate";
    answer: string;
    matchedQuestion: string;
    reason: string;
}

function parseDecision(text: string): AiQaDecision {
    const cleaned = String(text || "")
        .trim()
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    const jsonText = first !== -1 && last !== -1 ? cleaned.slice(first, last + 1) : cleaned;
    const parsed = JSON.parse(jsonText);

    const decision = parsed?.decision;
    if (decision !== "answer" && decision !== "escalate") {
        throw new Error("ИИ вернул неизвестное решение");
    }

    return {
        decision,
        answer: String(parsed?.answer || "").trim(),
        matchedQuestion: String(parsed?.matched_question || "").trim(),
        reason: String(parsed?.reason || "").trim(),
    };
}

function buildPrompt(vacancyName: string, candidateQuestion: string, knowledgeBase: VacancyQaItem[]): string {
    const kbText = knowledgeBase.map((item, index) =>
        `${index + 1}. Вопрос: ${item.question}\nОтвет: ${item.answer}`
    ).join("\n\n");

    return [
        "Ты HR-assistant для переписки с кандидатом по вакансии.",
        `Вакансия: ${vacancyName}`,
        "",
        "Тебе дают базу знаний в формате вопрос-ответ.",
        "Нужно решить, можно ли уверенно ответить кандидату ТОЛЬКО на основе этой базы знаний.",
        "Если ответ в базе знаний есть или его можно уверенно дать по смыслу без выдумывания, верни decision=answer.",
        "Если в базе знаний ответа нет, данных недостаточно, есть неоднозначность или пришлось бы фантазировать, верни decision=escalate.",
        "Нельзя придумывать факты, условия, цифры, график, оплату или процессы, которых нет в базе знаний.",
        "Ответ кандидату должен быть кратким, вежливым и по делу, на русском языке.",
        "",
        "Верни только JSON такого вида:",
        "{\"decision\":\"answer|escalate\",\"answer\":\"...\",\"matched_question\":\"...\",\"reason\":\"...\"}",
        "",
        "База знаний:",
        kbText,
        "",
        `Вопрос кандидата: ${candidateQuestion}`,
    ].join("\n");
}

export async function decideCandidateAnswer(
    vacancyName: string,
    candidateQuestion: string,
    knowledgeBase: VacancyQaItem[]
): Promise<AiQaDecision> {
    if (knowledgeBase.length === 0) {
        return {
            decision: "escalate",
            answer: "",
            matchedQuestion: "",
            reason: "Лист «Вопрос-ответ» пуст",
        };
    }

    const raw = await askAi(buildPrompt(vacancyName, candidateQuestion, knowledgeBase));
    const decision = parseDecision(raw);

    if (decision.decision === "answer" && !decision.answer) {
        throw new Error("ИИ решил answer, но не вернул текст ответа");
    }

    return decision;
}
