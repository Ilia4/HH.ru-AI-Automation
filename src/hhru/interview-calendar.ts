import { sheets } from "../google/sheets.client";

export interface InterviewSlot {
    date: string;
    time: string;
}

export interface InterviewBooking extends InterviewSlot {
    vacancyName: string;
    candidateFullName: string;
    resumeUrl?: string | null;
    contactCandidate?: string | null;
}

interface CalendarSheet {
    sheetName: string;
    headerRowIndex: number;
    headers: string[];
    dataRows: string[][];
}

function parseSheetName(range: string | undefined): string {
    const raw = String(range || "").trim();
    if (!raw.includes("!")) return "сводная таблица кандидатов (копия)";
    return raw.split("!")[0];
}

function normalizeHeader(text: string): string {
    return String(text || "").trim().toLowerCase();
}

function findHeaderIndex(headers: string[], variants: string[]): number {
    const normalizedHeaders = headers.map(normalizeHeader);
    return normalizedHeaders.findIndex((header) => variants.includes(header));
}

async function readCalendarSheet(): Promise<CalendarSheet> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CALENDAR;
    const range = process.env.GOOGLE_SHEETS_RANGE_CALENDAR;
    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_CALENDAR не указан в .env");
    if (!range) throw new Error("GOOGLE_SHEETS_RANGE_CALENDAR не указан в .env");

    const sheetName = parseSheetName(range);
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
    });
    const rows = response.data.values || [];
    const headerRowIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === "наименование вакансии"));
    if (headerRowIndex === -1) {
        throw new Error(`в листе "${sheetName}" не найдена строка заголовков календаря`);
    }

    const headers = rows[headerRowIndex].map((cell) => String(cell || ""));
    const dataRows = rows.slice(headerRowIndex + 1)
        .filter((row) => row.some((cell) => String(cell || "").trim()));

    return { sheetName, headerRowIndex, headers, dataRows };
}

function parseBookingFromRow(headers: string[], row: string[]): InterviewBooking | null {
    const vacancyIdx = findHeaderIndex(headers, ["наименование вакансии", "вакансия"]);
    const candidateIdx = findHeaderIndex(headers, ["фио", "кандидат"]);
    const resumeIdx = findHeaderIndex(headers, ["ссылка на резюме на нн", "ссылка на резюме"]);
    const dateIdx = findHeaderIndex(headers, ["дата"]);
    const timeIdx = findHeaderIndex(headers, ["время"]);
    const contactIdx = findHeaderIndex(headers, ["связаться с кандидатом", "связаться с кандидатом "]);

    if (vacancyIdx === -1 || candidateIdx === -1 || dateIdx === -1 || timeIdx === -1) return null;

    const booking: InterviewBooking = {
        vacancyName: String(row[vacancyIdx] || "").trim(),
        candidateFullName: String(row[candidateIdx] || "").trim(),
        resumeUrl: resumeIdx === -1 ? null : String(row[resumeIdx] || "").trim() || null,
        date: String(row[dateIdx] || "").trim(),
        time: String(row[timeIdx] || "").trim(),
        contactCandidate: contactIdx === -1 ? null : String(row[contactIdx] || "").trim() || null,
    };

    if (!booking.vacancyName || !booking.candidateFullName || !booking.date || !booking.time) return null;
    return booking;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

export function normalizeDate(date: string): string {
    const parts = String(date || "").trim().split(/[.\-/]/).map((chunk) => chunk.trim()).filter(Boolean);
    if (parts.length !== 3) return "";
    let day: number;
    let month: number;
    let year: number;

    if (parts[0].length === 4) {
        year = Number(parts[0]);
        month = Number(parts[1]);
        day = Number(parts[2]);
    } else {
        day = Number(parts[0]);
        month = Number(parts[1]);
        year = Number(parts[2]);
    }

    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return "";
    return `${pad(day)}.${pad(month)}.${year}`;
}

export function normalizeTime(time: string): string {
    const match = String(time || "").trim().match(/(\d{1,2})[:.](\d{2})/);
    if (!match) return "";
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
    return `${pad(hours)}:${pad(minutes)}`;
}

export function isWeekend(date: string): boolean {
    const normalized = normalizeDate(date);
    const [day, month, year] = normalized.split(".").map(Number);
    const jsDate = new Date(year, month - 1, day);
    const weekday = jsDate.getDay();
    return weekday === 0 || weekday === 6;
}

export function isTimeInAllowedWindow(time: string): boolean {
    const normalized = normalizeTime(time);
    if (!normalized) return false;
    const [hours, minutes] = normalized.split(":").map(Number);
    const total = hours * 60 + minutes;
    return total >= 10 * 60 && total <= 17 * 60;
}

export async function listInterviewBookings(): Promise<InterviewBooking[]> {
    const sheet = await readCalendarSheet();
    return sheet.dataRows
        .map((row) => parseBookingFromRow(sheet.headers, row))
        .filter(Boolean) as InterviewBooking[];
}

export async function isInterviewSlotAvailable(slot: InterviewSlot): Promise<boolean> {
    const targetDate = normalizeDate(slot.date);
    const targetTime = normalizeTime(slot.time);
    if (!targetDate || !targetTime) return false;

    const bookings = await listInterviewBookings();
    return !bookings.some((booking) =>
        normalizeDate(booking.date) === targetDate &&
        normalizeTime(booking.time) === targetTime
    );
}

export async function appendInterviewBooking(booking: InterviewBooking): Promise<void> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_CALENDAR;
    if (!spreadsheetId) throw new Error("GOOGLE_SHEETS_ID_CALENDAR не указан в .env");

    const sheet = await readCalendarSheet();
    const headers = sheet.headers;
    const row = new Array(headers.length).fill("");

    const vacancyIdx = findHeaderIndex(headers, ["наименование вакансии", "вакансия"]);
    const candidateIdx = findHeaderIndex(headers, ["фио", "кандидат"]);
    const resumeIdx = findHeaderIndex(headers, ["ссылка на резюме на нн", "ссылка на резюме"]);
    const dateIdx = findHeaderIndex(headers, ["дата"]);
    const timeIdx = findHeaderIndex(headers, ["время"]);
    const contactIdx = findHeaderIndex(headers, ["связаться с кандидатом", "связаться с кандидатом "]);

    if (vacancyIdx === -1 || candidateIdx === -1 || dateIdx === -1 || timeIdx === -1) {
        throw new Error(`в листе "${sheet.sheetName}" не хватает обязательных колонок календаря`);
    }

    row[vacancyIdx] = booking.vacancyName;
    row[candidateIdx] = booking.candidateFullName;
    if (resumeIdx !== -1) row[resumeIdx] = booking.resumeUrl || "";
    row[dateIdx] = normalizeDate(booking.date);
    row[timeIdx] = normalizeTime(booking.time);
    if (contactIdx !== -1) row[contactIdx] = booking.contactCandidate || "";

    // Пишем через update по точному адресу следующей строки. append() авто-детектит таблицу
    // и при пустом столбце A сдвигает данные на 1 колонку — из-за этого брони потом не читались.
    const colA = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheet.sheetName}!A:A` });
    const nextRow = (colA.data.values?.length || 0) + 1;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheet.sheetName}!A${nextRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
    });
}
