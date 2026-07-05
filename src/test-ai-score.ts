import "dotenv/config";
import { sheets } from "./google/sheets.client";
import { getNewResponses, getResume, getVacancy } from "./hhru/hh-api";
import { formatResumeText } from "./hhru/resume-format";
import { buildPrompt } from "./hhru/prompt-builder";
import { scoreCandidate } from "./hhru/ai-scorer";

/**
 * Тест полной цепочки оценки для ПЕРВОГО кандидата первой вакансии.
 * Запуск: npx tsx src/test-ai-score.ts [vacancyId]
 */

function extractVacancyId(url: string): string {
    const m = url.match(/\/vacancy\/(\d+)/);
    return m ? m[1] : "";
}

async function getFirstVacancy(): Promise<{ id: string; name: string }> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES!;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Лист1!A:C" });
    const rows = resp.data.values || [];
    for (const row of rows) {
        const name = String(row[0] || "").trim();
        const id = extractVacancyId(String(row[1] || "").trim());
        if (name && id) return { id, name };
    }
    throw new Error("Нет вакансии с hh.ru ссылкой");
}

async function main() {
    const argId = process.argv[2];
    const vacancy = argId ? { id: argId, name: "(arg)" } : await getFirstVacancy();
    console.log(`\n=== Вакансия: ${vacancy.name} (${vacancy.id}) ===`);

    const responses = await getNewResponses(vacancy.id);
    if (responses.length === 0) {
        console.log("Новых откликов нет");
        return;
    }

    const r = responses[0];
    const name = [r.resume?.last_name, r.resume?.first_name, r.resume?.middle_name].filter(Boolean).join(" ");
    console.log(`\nКандидат: ${name} (negotiation=${r.id}, resume=${r.resume?.id})`);

    console.log("→ тяну полное резюме...");
    const resume = await getResume(r.resume!.id!, r.id, vacancy.id);

    console.log("→ тяну описание вакансии...");
    const vacancyData = await getVacancy(vacancy.id);

    const resumeText = formatResumeText(resume, {
        vacancy_id: vacancy.id,
        vacancy_name: vacancy.name,
        negotiation_id: r.id,
    });

    const prompt = buildPrompt(vacancyData, "", {
        candidate_name: name,
        resume_title: resume.title || "",
        resume_url: resume.alternate_url || "",
        vacancy_id: vacancy.id,
        vacancy_name: vacancy.name,
        resume_text: resumeText,
    });

    console.log(`\n--- ДЛИНА ПРОМПТА: ${prompt.length} символов ---`);
    console.log("→ отправляю в ИИ openclaw...");
    const result = await scoreCandidate(prompt);

    console.log("\n=== РЕЗУЛЬТАТ ИИ ===");
    console.log("Балл:", result.score);
    console.log("Статус:", result.status);
    console.log("Комментарий:", result.ai_comment);
    console.log("\nГотово ✅");
}

main().catch((err) => {
    console.error("ОШИБКА:", err.message);
    process.exit(1);
});
