/**
 * Разбор анкеты кандидата для карточки в панели: вопрос → ответ кандидата → оценка ИИ.
 *
 * Данные лежат в двух местах и связываются по кандидату:
 *   • оценки ИИ  — лист «ИИ анализ тестового задания», колонки «Ответ на N вопрос»
 *                  (формат ячейки: «8 — комментарий»)
 *   • сам ответ  — таблица ответов Google-формы, ссылка на неё в «Доп. фильтры» → «Анкета»
 *
 * Нумерация вопросов начинается с 3 — так их называет разбор анкет в боте.
 */
import { sheets } from "../google/sheets.client";

const ANKETA_SHEET = "ИИ анализ тестового задания";
const FILTERS_SHEET = "Доп. фильтры";

const SERVICE_RE = /отметка времени|краткий коммент|^статус$|адрес электронной почты|e-?mail|почта/i;
const NAME_RE = /фио|фамили|как вас зовут|представьтесь|ваше\s*(полное\s*)?имя|ваши\s+фамили|напишите\s+ваши/i;
const PHONE_RE = /телефон|моб\.|phone/i;

const extractId = (url: string): string =>
    String(url || "").match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] || "";

const normName = (s: string): string[] =>
    String(s || "").toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean);

const normPhone = (s: string): string => {
    const d = String(s || "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : "";
};

export interface AnketaAnswerRow {
    num: number;
    question: string;
    answer: string;
    score: number | null;
    comment: string;
}

export interface AnketaDetail {
    ok: boolean;
    rows: AnketaAnswerRow[];
    conclusion: string;
    totalScore: string;
    /** нашли ли ответы кандидата в форме; если нет — показываем только оценки ИИ */
    answersFound: boolean;
    note?: string;
}

/** «8 — Сильный ответ по теме: …» → { score: 8, comment: "Сильный ответ…" } */
function parseAiCell(raw: string): { score: number | null; comment: string } {
    const text = String(raw || "").trim();
    if (!text) return { score: null, comment: "" };
    const m = text.match(/^\s*(\d+(?:[.,]\d+)?)\s*[—–-]\s*([\s\S]*)$/);
    if (!m) return { score: null, comment: text };
    return { score: Number(m[1].replace(",", ".")), comment: m[2].trim() };
}

// Формы с собственной нумерацией в заголовках («1. Расскажите…») — у них номера
// берутся из текста, а не по порядку. Значения совпадают с разбором анкет в боте.
const NUMBERED_FORM_WITHOUT_PHONE_ID = "1TYzJKQ6xAIolEeF-qtAf32tTOMe9ofxN9ZG9CYzkwTI";
const ENGINEER_FORM_ID = "1mOTlN2fr-VBjWguWnV5k-0AI-0f26WBfooDAJyuROHA";

/** Вопросы формы в том же порядке и с той же нумерацией, что видит бот. */
function formQuestions(rawHeaders: string[], formId = ""): { num: number; title: string; col: number }[] {
    const kept = rawHeaders
        .map((title, col) => ({ title: String(title || "").trim(), col }))
        .filter((k) => k.title && k.title.toLowerCase() !== "вопрос без заголовка");

    const isEngineer = formId === ENGINEER_FORM_ID;
    if (isEngineer || formId === NUMBERED_FORM_WITHOUT_PHONE_ID) {
        const minNum = isEngineer ? 1 : 3;
        return kept.flatMap((k) => {
            const m = k.title.match(/^\s*(\d+)\s*[.)]/);
            if (!m) return [];
            const num = Number(m[1]);
            return num >= minNum ? [{ num, title: k.title, col: k.col }] : [];
        });
    }

    const resumeCol = rawHeaders.findIndex((h) => /резюме|resume/i.test(h));
    const nameByHeader = rawHeaders.findIndex((h) => NAME_RE.test(h));
    const phoneByHeader = rawHeaders.findIndex((h) => PHONE_RE.test(h));
    const nameCol = nameByHeader >= 0 ? nameByHeader : (kept[1]?.col ?? 1);
    let phoneCol: number;
    if (phoneByHeader >= 0) phoneCol = phoneByHeader;
    else {
        const fb = kept[2]?.col ?? 2;
        phoneCol = SERVICE_RE.test(rawHeaders[fb] || "") ? -1 : fb;
    }
    const skip = new Set([nameCol, phoneCol, resumeCol].filter((x) => x >= 0));

    return kept
        .filter((k) => !skip.has(k.col) && !SERVICE_RE.test(k.title))
        .map((k, i) => ({ num: i + 3, title: k.title, col: k.col }));
}

export async function getAnketaDetail(
    spreadsheetId: string,
    anketaRow: number,
    fio: string,
): Promise<AnketaDetail> {
    // 1. Оценки ИИ из листа анкет
    const sheet = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${ANKETA_SHEET}!A1:BZ`,
    });
    const all = sheet.data.values || [];
    if (all.length < 2) return { ok: false, rows: [], conclusion: "", totalScore: "", answersFound: false, note: "лист анкет пуст" };

    const headers = (all[0] || []).map((x: any) => String(x || "").trim());
    const row = all[anketaRow - 1] || [];
    if (!row.length) return { ok: false, rows: [], conclusion: "", totalScore: "", answersFound: false, note: "строка анкеты не найдена" };

    const idxOf = (re: RegExp) => headers.findIndex((h) => re.test(h));
    const conclusion = String(row[idxOf(/^Совокупное заключение$/i)] || "").trim();
    const totalScore = String(row[idxOf(/^Итоговый балл$/i)] || "").trim();
    const phoneFromSheet = "";

    const aiByNum = new Map<number, { score: number | null; comment: string }>();
    headers.forEach((h, i) => {
        const m = h.match(/^Ответ на (\d+) вопрос$/i);
        if (m) aiByNum.set(Number(m[1]), parseAiCell(String(row[i] || "")));
    });

    // 2. Ответы кандидата из таблицы ответов формы
    let questions: { num: number; title: string; col: number }[] = [];
    let answerRow: string[] | null = null;
    let note: string | undefined;

    try {
        const f = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${FILTERS_SHEET}!A:Z` });
        const frows = f.data.values || [];
        const fh = (frows[0] || []).map((x: any) => String(x || "").trim().toLowerCase());
        const col = fh.indexOf("анкета");
        let url = "";
        if (col >= 0) for (const r of frows.slice(1)) { const v = String(r[col] || "").trim(); if (v) { url = v; break; } }
        const formId = extractId(url);

        if (formId) {
            const meta = await sheets.spreadsheets.get({ spreadsheetId: formId });
            const tab = meta.data.sheets?.[0]?.properties?.title;
            const fd = await sheets.spreadsheets.values.get({ spreadsheetId: formId, range: `${tab}!A1:BZ` });
            const rows = fd.data.values || [];
            const raw = (rows[0] || []).map((x: any) => String(x || "").trim());
            questions = formQuestions(raw, formId);

            const nameByHeader = raw.findIndex((h) => NAME_RE.test(h));
            const nameCol = nameByHeader >= 0 ? nameByHeader : 1;
            const wanted = normName(fio);

            // ищем строку кандидата по ФИО: совпадение минимум двух слов
            let best: { row: string[]; overlap: number } | null = null;
            for (const r of rows.slice(1)) {
                const got = normName(String(r[nameCol] || ""));
                const overlap = wanted.filter((w) => got.includes(w)).length;
                if (overlap >= 2 && (!best || overlap > best.overlap)) best = { row: r, overlap };
            }
            if (best) answerRow = best.row;
            else note = "ответы кандидата в форме не найдены — показываю только оценки ИИ";
        } else {
            note = "в «Доп. фильтры» не указана ссылка на анкету";
        }
    } catch (e: any) {
        note = `не смог прочитать форму: ${String(e?.message || e).slice(0, 90)}`;
    }

    // 3. Склеиваем
    const nums = new Set<number>([...aiByNum.keys(), ...questions.map((q) => q.num)]);
    const rows: AnketaAnswerRow[] = [...nums].sort((a, b) => a - b).map((num) => {
        const q = questions.find((x) => x.num === num);
        const ai = aiByNum.get(num) || { score: null, comment: "" };
        return {
            num,
            question: q?.title || `Вопрос ${num}`,
            answer: q && answerRow ? String(answerRow[q.col] || "").trim() : "",
            score: ai.score,
            comment: ai.comment,
        };
    }).filter((r) => r.question || r.answer || r.comment);

    return { ok: true, rows, conclusion, totalScore, answersFound: !!answerRow, note };
}
