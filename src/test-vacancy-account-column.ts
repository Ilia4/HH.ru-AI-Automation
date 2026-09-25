import "dotenv/config";
import { sheets } from "./google/sheets.client";

async function main() {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_VACANCIES;
    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_VACANCIES missing");
    const configured = process.env.GOOGLE_SHEETS_RANGE_VACANCIES || "Лист1!A:E";
    const range = configured.replace(/:[A-Z]+(\d*)$/i, ":E$1");
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];
    rows.forEach((row, index) => {
        const values = [0, 1, 2, 3, 4].map((i) => String(row[i] || "").trim());
        if (!values.some(Boolean)) return;
        console.log(JSON.stringify({
            row: index + 1,
            vacancy: values[0],
            allFiveFilled: values.every(Boolean),
            hhAccount: values[4] || "(empty)",
        }));
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
