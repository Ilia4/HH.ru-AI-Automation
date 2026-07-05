import "dotenv/config";
import { sheets } from "./google/sheets.client";
import { getNewResponses, getConsiderResponses, extractActions } from "./hhru/hh-api";

/**
 * Тест клиента HH API.
 * Запуск: npx tsx src/test-hh-api.ts [vacancyId]
 * Если vacancyId не передан — берёт первую вакансию из Google-таблицы.
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
        const url = String(row[1] || "").trim();
        const id = extractVacancyId(url);
        if (name && id) return { id, name };
    }
    throw new Error("Не нашёл вакансию с hh.ru ссылкой в таблице");
}

async function main() {
    const argId = process.argv[2];
    const vacancy = argId
        ? { id: argId, name: "(из аргумента)" }
        : await getFirstVacancy();

    console.log(`\n=== Вакансия: ${vacancy.name} (id=${vacancy.id}) ===\n`);

    console.log("--- Новые отклики (negotiations/response) ---");
    const responses = await getNewResponses(vacancy.id);
    console.log(`Найдено: ${responses.length}`);
    for (const r of responses.slice(0, 5)) {
        const name = [r.resume?.last_name, r.resume?.first_name, r.resume?.middle_name].filter(Boolean).join(" ");
        const actions = extractActions(r);
        console.log(`• ${name || r.resume?.title || "Без имени"} | negotiation=${r.id} | resume=${r.resume?.id} | state=${r.state?.name}`);
        console.log(`    consider: ${actions.action_consider_url ? "есть" : "нет"}, discard: ${actions.action_discard_url ? "есть" : "нет"}, phone: ${actions.action_phone_interview_url ? "есть" : "нет"}`);
    }

    console.log("\n--- В стадии 'Подумать' (negotiations/consider) ---");
    const consider = await getConsiderResponses(vacancy.id);
    console.log(`Найдено: ${consider.length}`);
    for (const r of consider.slice(0, 5)) {
        const name = [r.resume?.last_name, r.resume?.first_name].filter(Boolean).join(" ");
        console.log(`• ${name || "Без имени"} | negotiation=${r.id}`);
    }

    console.log("\nГотово ✅");
}

main().catch((err) => {
    console.error("ОШИБКА:", err.message);
    process.exit(1);
});
