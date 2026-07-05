/**
 * Оценка кандидата через ИИ (openclaw).
 * Перенос нод n8n «Отправляем на оценку1» + «Готовим данные для записи».
 */

const AI_ENDPOINT = process.env.AI_ENDPOINT || "http://localhost:18789/v1/responses";
const AI_TOKEN = process.env.AI_TOKEN || "";
const AI_MODEL = process.env.AI_MODEL || "openclaw:main";

export interface AiResult {
    resume_url: string;
    ai_comment: string;
    score: number | "";
    status: string; // "Подходит" | "Ручная проверка" | "Отказ" | "Ошибка"
}

/** Достаёт текст ответа ИИ из разных возможных форматов */
function extractAiText(json: any): string {
    const output = json?.output;
    if (Array.isArray(output)) {
        for (const message of output) {
            if (!Array.isArray(message.content)) continue;
            for (const content of message.content) {
                if (content.type === "output_text" && content.text) return content.text;
            }
        }
    }
    if (json?.output_text) return json.output_text;
    if (json?.text) return json.text;
    if (json?.message) return json.message;
    if (json?.content) return typeof json.content === "string" ? json.content : "";
    return "";
}

function parseAiJson(text: string): any {
    if (!text) return { resume_url: "", ai_comment: "ИИ не вернул текст ответа", score: "", status: "Ошибка" };

    let cleaned = String(text).trim()
        .replace(/^```json/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last !== -1) cleaned = cleaned.slice(first, last + 1);

    try {
        return JSON.parse(cleaned);
    } catch {
        return { resume_url: "", ai_comment: `Не удалось распарсить JSON от ИИ. Ответ: ${text}`, score: "", status: "Ошибка" };
    }
}

function normalizeScore(score: any): number | "" {
    if (score === null || score === undefined || score === "") return "";
    const num = Number(score);
    if (Number.isNaN(num)) return "";
    return Math.max(0, Math.min(10, num));
}

/** Статус строго по баллу (как в n8n: <5 Отказ, 5-6 Ручная проверка, >=7 Подходит) */
function statusByScore(score: number | ""): string {
    if (score === "") return "Ручная проверка";
    if (score < 5) return "Отказ";
    if (score < 7) return "Ручная проверка";
    return "Подходит";
}

/** Низкоуровневый вызов ИИ — возвращает сырой текст ответа */
export async function askAi(prompt: string): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (AI_TOKEN) headers.Authorization = `Bearer ${AI_TOKEN}`;

    const res = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: AI_MODEL, input: prompt }),
    });

    if (!res.ok) {
        const t = await res.text();
        throw new Error(`AI ${res.status}: ${t.slice(0, 300)}`);
    }

    const json = await res.json();
    return extractAiText(json);
}

/** Парсит JSON из ответа ИИ (с очисткой markdown-обёртки) */
export function parseAiJsonText(text: string): any {
    return parseAiJson(text);
}

/** Отправляет промпт в ИИ и возвращает распарсенный результат оценки резюме */
export async function scoreCandidate(prompt: string): Promise<AiResult> {
    const aiText = await askAi(prompt);
    const ai = parseAiJson(aiText);

    const score = normalizeScore(ai.score);
    // балл — источник правды для статуса; если ИИ дал статус, но он не сходится с баллом — приоритет баллу
    const status = score === "" ? (ai.status || "Ручная проверка") : statusByScore(score);

    return {
        resume_url: ai.resume_url || "",
        ai_comment: ai.ai_comment || "Комментарий не указан",
        score,
        status,
    };
}
