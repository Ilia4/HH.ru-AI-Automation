import "dotenv/config";
import { sheets } from "./google/sheets.client";
import { processVacancyQuestionnaire } from "./hhru/questionnaire";

/**
 * Тест обработки анкет. Запуск: npx tsx src/test-anketa.ts [фильтр по названию вакансии]
 */
function extractVacancyId(url: string): string {
    const m = url.match(/\/vacancy\/(\d+)/);
    return m ? m[1] : "";
}

async function getVacancies() {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES!;
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range: "Лист1!A:C" });
    const rows = resp.data.values || [];
    return rows
        .map((row) => ({
            vacancyName: String(row[0] || "").trim(),
            hhUrl: String(row[1] || "").trim(),
            templatesUrl: String(row[2] || "").trim() || null,
        }))
        .filter((v) => v.vacancyName && v.hhUrl.includes("hh.ru/vacancy/"))
        .map((v) => ({ ...v, vacancyId: extractVacancyId(v.hhUrl) }))
        .filter((v) => v.vacancyId);
}

async function main() {
    const filter = process.argv[2]?.toLowerCase();
    let vacancies = await getVacancies();
    if (filter) vacancies = vacancies.filter((v) => v.vacancyName.toLowerCase().includes(filter));

    const v = vacancies[0];
    if (!v) { console.log("Вакансия не найдена"); return; }

    console.log(`Вакансия: ${v.vacancyName} (${v.vacancyId})`);
    console.log(`templatesUrl: ${v.templatesUrl}\n`);

    const result = await processVacancyQuestionnaire({
        vacancyId: v.vacancyId,
        vacancyName: v.vacancyName,
        templatesUrl: v.templatesUrl,
    });

    console.log("\n=== ИТОГ ===");
    console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
