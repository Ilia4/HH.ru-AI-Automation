import "dotenv/config";
import { sheets } from "../google/sheets.client";
import { extractSpreadsheetId } from "../chat-sim/vacancies";
import { listHhAccounts, normalizeAccountEmail } from "../hh-auth/accounts.service";
import { withHhAccount } from "../hh-auth/account-context";
import { getVacancy } from "../hhru/hh-api";
import { listRegistry, type RegistryVacancy } from "./registry";

const RESUME_SHEET = "ИИ анализ резюме";
const ANKETA_SHEET = "ИИ анализ тестового задания";
const TEMPLATES_SHEET = "Автоответы";
const FILTERS_SHEET = "Доп. фильтры";
const CACHE_MS = 10 * 60 * 1000;

const NUMBERED_FORM_WITHOUT_PHONE_ID = "1TYzJKQ6xAIolEeF-qtAf32tTOMe9ofxN9ZG9CYzkwTI";
const ENGINEER_FORM_ID = "1mOTlN2fr-VBjWguWnV5k-0AI-0f26WBfooDAJyuROHA";
const EMPTY_HEADERS = ["", "вопрос без заголовка"];
const SERVICE_RE = /отметка времени|краткий коммент|^статус$|адрес электронной почты|e-?mail|почта/i;
const NAME_RE = /фио|фамили|как вас зовут|представьтесь|ваше\s*(полное\s*)?имя|ваши\s+фамили|напишите\s+ваши/i;
const PHONE_RE = /телефон|моб\.|phone/i;

export type DiagnosticSeverity = "error" | "warn" | "info";

export interface DiagnosticIssue {
    code: string;
    severity: DiagnosticSeverity;
    title: string;
    vacancy: string;
    message: string;
    action: string;
    link?: string;
}

export interface VacancyDiagnostic {
    row: number;
    vacancyId: string;
    name: string;
    hhUrl: string;
    tableUrl: string;
    account: string;
    responsible: string;
    registryStatus: RegistryVacancy["status"];
    hhStatus: "active" | "archived" | "unknown" | "not-configured";
    responsesMode: "LIVE" | "DRY" | "OFF";
    anketaMode: "LIVE" | "DRY" | "OFF";
    chatMode: "LIVE" | "DRY" | "OFF";
    tableStatus: "ok" | "warn" | "error" | "not-configured";
    errors: number;
    warnings: number;
}

export interface AccountDiagnostic {
    email: string;
    status: string;
    employerName: string;
    expiresAt: string;
    lastSuccessAt: string;
    lastError: string;
}

export interface DiagnosticsResult {
    issues: DiagnosticIssue[];
    vacancies: VacancyDiagnostic[];
    accounts: AccountDiagnostic[];
    summary: {
        errors: number;
        warnings: number;
        archived: number;
        live: number;
        dry: number;
        tablesOk: number;
    };
    ts: string;
}

let cache: { at: number; data: DiagnosticsResult } | null = null;
let googleNextAt = 0;

const lc = (value: unknown) => String(value ?? "").trim().toLowerCase();
const normHeader = (value: unknown) => lc(value).replace(/\s+/g, " ");
const extractFormId = (url: string) =>
    String(url || "").match(/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] || "";

async function googleCall<T>(fn: () => Promise<T>): Promise<T> {
    const wait = Math.max(0, googleNextAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    googleNextAt = Date.now() + 700;
    return fn();
}

function pushIssue(
    issues: DiagnosticIssue[],
    vacancy: RegistryVacancy,
    issue: Omit<DiagnosticIssue, "vacancy" | "link"> & { link?: string },
): void {
    issues.push({
        ...issue,
        vacancy: vacancy.name,
        link: issue.link || vacancy.templatesUrl || vacancy.hhUrl,
    });
}

function requiredMissing(headers: string[], required: string[]): string[] {
    const normalized = new Set(headers.map(normHeader));
    return required.filter((header) => !normalized.has(normHeader(header)));
}

function readRange(
    ranges: Array<{ range?: string | null; values?: unknown[][] | null }>,
    sheetName: string,
): unknown[][] {
    const found = ranges.find((range) => String(range.range || "").replace(/^'|'!/g, "").startsWith(sheetName));
    return (found?.values || []) as unknown[][];
}

function formQuestionNumbers(formId: string, rawHeaders: string[]): number[] {
    const kept = rawHeaders
        .map((title, colIndex) => ({ title: String(title || "").trim(), colIndex }))
        .filter((item) => !EMPTY_HEADERS.includes(item.title.toLowerCase()));
    const isEngineer = formId === ENGINEER_FORM_ID;
    const isNumbered = isEngineer || formId === NUMBERED_FORM_WITHOUT_PHONE_ID;
    const resumeCol = rawHeaders.findIndex((header) => /резюме|resume/i.test(header));
    const nameCol = rawHeaders.findIndex((header) => NAME_RE.test(header));
    const phoneCol = isNumbered ? -1 : rawHeaders.findIndex((header) => PHONE_RE.test(header));

    if (isNumbered) {
        const min = isEngineer ? 1 : 3;
        return kept.flatMap((item) => {
            const match = item.title.match(/^\s*(\d+)\s*[.)]/);
            const num = match ? Number(match[1]) : 0;
            return num >= min ? [num] : [];
        });
    }

    const skip = new Set([resumeCol, nameCol, phoneCol].filter((index) => index >= 0));
    return kept
        .filter((item) => !skip.has(item.colIndex) && !SERVICE_RE.test(item.title))
        .map((_item, index) => index + 3);
}

function resultQuestionNumbers(headers: string[]): number[] {
    return headers
        .map((header) => normHeader(header).match(/^ответ на (\d+) вопрос$/)?.[1])
        .filter(Boolean)
        .map(Number);
}

function duplicateExamples(rows: unknown[][], headers: string[], by: "fio" | "resume"): string[] {
    const index =
        by === "fio"
            ? headers.findIndex((header) => normHeader(header) === "фио")
            : headers.findIndex((header) => normHeader(header).includes("ссылка") && normHeader(header).includes("резюме"));
    if (index < 0) return [];
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    rows.slice(1).forEach((row, offset) => {
        let key = String(row[index] || "").trim().toLowerCase().replace(/ё/g, "е");
        if (by === "resume") key = key.match(/\/resume\/([^?&#/]+)/i)?.[1] || "";
        else key = key.replace(/[^а-яa-z\s]/gi, " ").replace(/\s+/g, " ").trim().split(" ").sort().join(" ");
        if (!key) return;
        const rowNumber = offset + 2;
        const first = seen.get(key);
        if (first) duplicates.push(`${String(row[index] || "").trim()} — строки ${first} и ${rowNumber}`);
        else seen.set(key, rowNumber);
    });
    return duplicates.slice(0, 4);
}

function modeFor(vacancyId: string, globalDryFlag: string | undefined): "LIVE" | "DRY" {
    const liveIds = String(process.env.LIVE_VACANCY_IDS || "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    if (liveIds.includes(vacancyId)) return "LIVE";
    return globalDryFlag === "false" ? "LIVE" : "DRY";
}

async function inspectVacancy(
    vacancy: RegistryVacancy,
    accountByEmail: Map<string, Awaited<ReturnType<typeof listHhAccounts>>[number]>,
): Promise<{ diagnostic: VacancyDiagnostic; issues: DiagnosticIssue[] }> {
    const issues: DiagnosticIssue[] = [];
    const base: VacancyDiagnostic = {
        row: vacancy.row,
        vacancyId: vacancy.vacancyId,
        name: vacancy.name,
        hhUrl: vacancy.hhUrl,
        tableUrl: vacancy.templatesUrl,
        account: vacancy.account,
        responsible: vacancy.responsible,
        registryStatus: vacancy.status,
        hhStatus: vacancy.status === "draft" ? "not-configured" : "unknown",
        responsesMode: vacancy.status === "active" ? modeFor(vacancy.vacancyId, process.env.HHRU_DRY_RUN) : "OFF",
        anketaMode: vacancy.status === "active" ? modeFor(vacancy.vacancyId, process.env.ANKETA_HR_DRY_RUN) : "OFF",
        chatMode: vacancy.status === "active" ? modeFor(vacancy.vacancyId, process.env.CHAT_ROUTER_DRY_RUN) : "OFF",
        tableStatus: vacancy.status === "draft" ? "not-configured" : "ok",
        errors: 0,
        warnings: 0,
    };

    if (vacancy.status === "draft") {
        pushIssue(issues, vacancy, {
            code: "registry-draft",
            severity: "info",
            title: "Вакансия заполнена не полностью",
            message: "В реестре не хватает ссылки HH, таблицы, ответственного или аккаунта HH.",
            action: "Откройте раздел «Вакансии» и заполните все обязательные поля.",
        });
        return { diagnostic: base, issues };
    }

    const account = accountByEmail.get(normalizeAccountEmail(vacancy.account));
    if (!account) {
        pushIssue(issues, vacancy, {
            code: "account-missing",
            severity: "error",
            title: "Аккаунт HH не подключён",
            message: `В реестре указан аккаунт «${vacancy.account}», но его нет среди подключённых аккаунтов.`,
            action: "Авторизуйте этот аккаунт через /auth или выберите подключённый аккаунт в реестре вакансий.",
        });
    } else if (account.status !== "active" || account.lastError) {
        pushIssue(issues, vacancy, {
            code: "account-unhealthy",
            severity: "error",
            title: "Проблема с аккаунтом HH",
            message: account.lastError || `Статус аккаунта: ${account.status}.`,
            action: "Проверьте авторизацию HH через /authstatus; при необходимости выполните /auth.",
        });
    }

    if (account && vacancy.vacancyId) {
        try {
            const hh: any = await withHhAccount(account.id, () => getVacancy(vacancy.vacancyId));
            base.hhStatus = hh?.archived ? "archived" : "active";
            if (hh?.archived) {
                pushIssue(issues, vacancy, {
                    code: "hh-archived",
                    severity: "warn",
                    title: "Вакансия в архиве на HH",
                    message: "HH не разрешит боту отправлять сообщения и менять этапы по этой вакансии.",
                    action: "Если набор продолжается — восстановите вакансию на HH. Если закончен — отключите её в панели.",
                    link: vacancy.hhUrl,
                });
            }
        } catch (error: any) {
            base.hhStatus = "unknown";
            pushIssue(issues, vacancy, {
                code: "hh-check-failed",
                severity: "warn",
                title: "Не удалось проверить статус вакансии на HH",
                message: String(error?.message || error).slice(0, 260),
                action: "Повторите проверку позже. Если ошибка сохраняется — проверьте аккаунт HH.",
                link: vacancy.hhUrl,
            });
        }
    }

    const spreadsheetId = extractSpreadsheetId(vacancy.templatesUrl);
    if (!spreadsheetId) {
        base.tableStatus = "error";
        pushIssue(issues, vacancy, {
            code: "table-link-invalid",
            severity: "error",
            title: "Неверная ссылка на Google-таблицу",
            message: "Из ссылки в реестре не удалось извлечь ID Google-таблицы.",
            action: "Вставьте полную ссылку вида https://docs.google.com/spreadsheets/d/…",
        });
        base.errors = 1;
        return { diagnostic: base, issues };
    }

    try {
        const [batch, meta] = await Promise.all([
            googleCall(() =>
                sheets.spreadsheets.values.batchGet({
                    spreadsheetId,
                    ranges: [
                        `${RESUME_SHEET}!A1:BZ200`,
                        `${ANKETA_SHEET}!A1:BZ200`,
                        `${TEMPLATES_SHEET}!A1:D20`,
                        `${FILTERS_SHEET}!A1:Z30`,
                    ],
                }),
            ),
            googleCall(() =>
                sheets.spreadsheets.get({
                    spreadsheetId,
                    includeGridData: true,
                    ranges: [`${ANKETA_SHEET}!A2:BZ200`],
                    fields: "sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(dataValidation))))",
                }),
            ),
        ]);

        const ranges = batch.data.valueRanges || [];
        const resumeRows = readRange(ranges, RESUME_SHEET);
        const anketaRows = readRange(ranges, ANKETA_SHEET);
        const templateRows = readRange(ranges, TEMPLATES_SHEET);
        const filterRows = readRange(ranges, FILTERS_SHEET);
        const resumeHeaders = (resumeRows[0] || []).map(String);
        const anketaHeaders = (anketaRows[0] || []).map(String);

        const missingResume = requiredMissing(resumeHeaders, [
            "Ссылка на резюме",
            "Комментарии ИИ",
            "Балл",
            "Статус",
            "Дата обработки",
            "ФИО",
        ]);
        const missingAnketa = requiredMissing(anketaHeaders, [
            "Ссылка на резюме",
            "Совокупное заключение",
            "Итоговый балл",
            "Дата анализа анкеты",
            "Действие HR",
            "ФИО",
        ]);
        if (missingResume.length) {
            pushIssue(issues, vacancy, {
                code: "resume-headers",
                severity: "error",
                title: "Неверная структура листа «ИИ анализ резюме»",
                message: `Не найдены колонки: ${missingResume.join(", ")}.`,
                action: "Верните канонические заголовки первой строки. Не переименовывайте служебные колонки.",
            });
        }
        if (missingAnketa.length) {
            pushIssue(issues, vacancy, {
                code: "anketa-headers",
                severity: "error",
                title: "Неверная структура листа анкет",
                message: `Не найдены колонки: ${missingAnketa.join(", ")}.`,
                action: "Исправьте заголовки на листе «ИИ анализ тестового задания».",
            });
        }

        const filterHeaders = (filterRows[0] || []).map(normHeader);
        const formCol = filterHeaders.indexOf("анкета");
        const formUrl =
            formCol < 0
                ? ""
                : String(filterRows.slice(1).find((row) => String(row[formCol] || "").trim())?.[formCol] || "").trim();
        const formId = extractFormId(formUrl);
        if (!formId) {
            pushIssue(issues, vacancy, {
                code: "form-link-missing",
                severity: "error",
                title: "Не настроена ссылка на анкету",
                message: "В листе «Доп. фильтры» нет корректной ссылки в колонке «Анкета».",
                action: "Добавьте ссылку на Google-таблицу ответов формы в колонку «Анкета».",
            });
        } else if (anketaHeaders.length) {
            try {
                const formHeaderResp = await googleCall(() =>
                    sheets.spreadsheets.values.get({ spreadsheetId: formId, range: "1:1" }),
                );
                const formHeaders = (formHeaderResp.data.values?.[0] || []).map(String);
                const expectedQuestions = formQuestionNumbers(formId, formHeaders);
                const resultQuestions = resultQuestionNumbers(anketaHeaders);
                const missingQuestions = expectedQuestions.filter((num) => !resultQuestions.includes(num));
                if (missingQuestions.length) {
                    pushIssue(issues, vacancy, {
                        code: "question-columns-missing",
                        severity: "error",
                        title: "В листе не хватает колонок для вопросов анкеты",
                        message: `Не найдены: ${missingQuestions.map((num) => `«Ответ на ${num} вопрос»`).join(", ")}.`,
                        action: "Добавьте недостающие колонки между блоком ответов и «Совокупным заключением».",
                    });
                }
            } catch (error: any) {
                pushIssue(issues, vacancy, {
                    code: "form-unreadable",
                    severity: "warn",
                    title: "Не удалось прочитать таблицу ответов анкеты",
                    message: String(error?.message || error).slice(0, 260),
                    action: "Проверьте доступ сервисного аккаунта к таблице ответов формы.",
                });
            }
        }

        const expectedTemplates = new Set([
            "успешно|резюме",
            "отказ|резюме",
            "успешно|тестовое задание",
            "отказ|тестовое задание",
        ]);
        const templateHeaders = (templateRows[0] || []).map(normHeader);
        const conditionCol = templateHeaders.findIndex((header) => header.includes("условие"));
        const typeCol = templateHeaders.indexOf("тип");
        const textCol = templateHeaders.indexOf("текст");
        const foundTemplates = new Set<string>();
        for (const row of templateRows.slice(1)) {
            const condition = normHeader(row[conditionCol]);
            const type = normHeader(row[typeCol]);
            const text = String(row[textCol] || "").trim();
            if (condition && type && text) foundTemplates.add(`${condition}|${type}`);
        }
        const missingTemplates = [...expectedTemplates].filter((key) => !foundTemplates.has(key));
        if (missingTemplates.length) {
            pushIssue(issues, vacancy, {
                code: "templates-missing",
                severity: "error",
                title: "Не хватает шаблонов сообщений",
                message: `Не настроены: ${missingTemplates.join(", ")}.`,
                action: "Заполните лист «Автоответы»: условие, тип и текст сообщения.",
            });
        }

        const hrIndex = anketaHeaders.findIndex((header) => normHeader(header) === "действие hr");
        const validationColumns = new Set<number>();
        const anketaGrid = (meta.data.sheets || []).find((sheet) => sheet.properties?.title === ANKETA_SHEET);
        for (const data of anketaGrid?.data || []) {
            const startColumn = data.startColumn || 0;
            for (const row of data.rowData || []) {
                (row.values || []).forEach((gridCell, index) => {
                    const values = gridCell.dataValidation?.condition?.values?.map((value) => value.userEnteredValue) || [];
                    if (values.includes("Подходит") && values.includes("Не подходит")) {
                        validationColumns.add(startColumn + index);
                    }
                });
            }
        }
        const misplaced = [...validationColumns].filter((column) => column !== hrIndex);
        if (misplaced.length) {
            pushIssue(issues, vacancy, {
                code: "dropdown-misplaced",
                severity: "error",
                title: "Выпадающий список стоит не в той колонке",
                message: `Список решений найден в колонках ${misplaced.map((index) => index + 1).join(", ")}, а должен быть только в «Действие HR».`,
                action: "Снимите проверку данных с лишних колонок и поставьте её на «Действие HR».",
            });
        }
        if (hrIndex >= 0 && !validationColumns.has(hrIndex)) {
            pushIssue(issues, vacancy, {
                code: "dropdown-missing",
                severity: "warn",
                title: "Нет выпадающего списка «Действие HR»",
                message: "Колонка есть, но пользователю придётся вводить статус вручную; опечатка не будет обработана ботом.",
                action: "Добавьте список: Ожидание, Подходит, Не подходит.",
            });
        }

        const invalidResume = resumeRows
            .slice(1)
            .map((row, index) => ({ row: index + 2, value: String(row[resumeHeaders.findIndex((h) => normHeader(h) === "статус")] || "").trim() }))
            .filter((item) => item.value && !["Ручная проверка", "Подходит", "Отказ"].includes(item.value));
        if (invalidResume.length) {
            pushIssue(issues, vacancy, {
                code: "resume-status-invalid",
                severity: "error",
                title: "Бот не понимает часть статусов резюме",
                message: invalidResume.slice(0, 4).map((item) => `строка ${item.row}: «${item.value}»`).join("; "),
                action: "Используйте только: Ручная проверка, Подходит, Отказ.",
            });
        }

        const invalidAnketa = anketaRows
            .slice(1)
            .map((row, index) => ({
                row: index + 2,
                value: String(row[anketaHeaders.findIndex((h) => normHeader(h) === "действие hr")] || "").trim(),
            }))
            .filter((item) => item.value && !["Ожидание", "Подходит", "Не подходит"].includes(item.value));
        if (invalidAnketa.length) {
            pushIssue(issues, vacancy, {
                code: "anketa-status-invalid",
                severity: "error",
                title: "Бот не понимает часть решений по анкетам",
                message: invalidAnketa.slice(0, 4).map((item) => `строка ${item.row}: «${item.value}»`).join("; "),
                action: "Используйте только: Ожидание, Подходит, Не подходит.",
            });
        }

        const duplicateResume = duplicateExamples(resumeRows, resumeHeaders, "resume");
        const duplicateAnketa = duplicateExamples(anketaRows, anketaHeaders, "fio");
        if (duplicateResume.length || duplicateAnketa.length) {
            pushIssue(issues, vacancy, {
                code: "duplicates",
                severity: "warn",
                title: "Найдены возможные дубли строк",
                message: [...duplicateResume, ...duplicateAnketa].slice(0, 4).join("; "),
                action: "Сверьте строки и удалите только подтверждённый дубль. Сначала создайте бэкап листа.",
            });
        }
    } catch (error: any) {
        base.tableStatus = "error";
        pushIssue(issues, vacancy, {
            code: "table-unreadable",
            severity: "error",
            title: "Google-таблица недоступна",
            message: String(error?.message || error).slice(0, 300),
            action: "Проверьте ссылку и доступ сервисного аккаунта к таблице.",
        });
    }

    base.errors = issues.filter((issue) => issue.severity === "error").length;
    base.warnings = issues.filter((issue) => issue.severity === "warn").length;
    const tableIssueCodes = new Set([
        "table-unreadable",
        "sheet-missing",
        "headers-missing",
        "form-missing",
        "questions-missing",
        "templates-missing",
        "validation-missing",
        "validation-wrong-column",
        "resume-status-invalid",
        "anketa-status-invalid",
        "duplicates",
    ]);
    const tableIssues = issues.filter((issue) => tableIssueCodes.has(issue.code));
    base.tableStatus = tableIssues.some((issue) => issue.severity === "error")
        ? "error"
        : tableIssues.some((issue) => issue.severity === "warn")
          ? "warn"
          : "ok";
    return { diagnostic: base, issues };
}

export async function getDiagnostics(force = false): Promise<DiagnosticsResult> {
    if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;

    const [{ vacancies }, accounts] = await Promise.all([listRegistry(), listHhAccounts(true)]);
    const accountByEmail = new Map(accounts.map((account) => [normalizeAccountEmail(account.email), account]));
    const diagnostics: VacancyDiagnostic[] = [];
    const issues: DiagnosticIssue[] = [];

    for (const vacancy of vacancies) {
        const result = await inspectVacancy(vacancy, accountByEmail);
        diagnostics.push(result.diagnostic);
        issues.push(...result.issues);
    }

    const data: DiagnosticsResult = {
        issues: issues.sort(
            (a, b) =>
                ({ error: 0, warn: 1, info: 2 }[a.severity] - { error: 0, warn: 1, info: 2 }[b.severity]) ||
                a.vacancy.localeCompare(b.vacancy, "ru"),
        ),
        vacancies: diagnostics,
        accounts: accounts.map((account) => ({
            email: account.email,
            status: account.status,
            employerName: account.employerName || "",
            expiresAt: account.expiresAt?.toISOString?.() || "",
            lastSuccessAt: account.lastSuccessAt?.toISOString?.() || "",
            lastError: account.lastError || "",
        })),
        summary: {
            errors: issues.filter((issue) => issue.severity === "error").length,
            warnings: issues.filter((issue) => issue.severity === "warn").length,
            archived: diagnostics.filter((vacancy) => vacancy.hhStatus === "archived").length,
            live: diagnostics.filter((vacancy) => vacancy.responsesMode === "LIVE").length,
            dry: diagnostics.filter((vacancy) => vacancy.responsesMode === "DRY").length,
            tablesOk: diagnostics.filter((vacancy) => vacancy.tableStatus === "ok").length,
        },
        ts: new Date().toISOString(),
    };
    cache = { at: Date.now(), data };
    return data;
}
