/**
 * Раздел «Создать вакансию» + управление активными вакансиями.
 * Работает с реестром вакансий (GOOGLE_SHEETS_ID_VACANCIES, лист «Лист1», колонки A–E).
 *
 * Отключение БЕЗ правки кода бота: бот считает вакансию активной только если заполнены
 * все A–E. Мы прячем аккаунт HH (кол. E) в резервную кол. F и очищаем E — бот перестаёт
 * опрашивать вакансию. Включение — переносим F→E обратно. Строки не удаляем.
 */
import { sheets } from "../google/sheets.client";
import { listHhAccounts, normalizeAccountEmail } from "../hh-auth/accounts.service";
import { parseVacancyMode, type VacancyMode } from "../hhru/vacancy-mode";
import { invalidatePrefix } from "../lib/sheet-cache";
import { parseWorkflowMode, workflowModeCell, type WorkflowMode } from "../hhru/workflow-mode";
import { setRuntimeVacancyActive } from "../hhru/vacancy-activity";
import { removePeriodStats } from "../hhru/period.store";

const COL = { name: 0, hhUrl: 1, templatesUrl: 2, responsible: 3, account: 4, stash: 5, mode: 6, workflow: 7 };

export type VacancyStatus = "active" | "disabled" | "draft";
export interface RegistryVacancy {
    row: number;
    name: string;
    hhUrl: string;
    vacancyId: string;
    templatesUrl: string;
    responsible: string;
    account: string;
    status: VacancyStatus;
    /** «боевой» — бот пишет кандидатам; «тест» — только анализ, без отправки */
    mode: VacancyMode;
    /** Что идёт после анализа резюме: анкета или вопрос кандидату в чате HH. */
    workflow: WorkflowMode;
}

function registryId(): string {
    const id = process.env.GOOGLE_SHEETS_ID_VACANCIES;
    if (!id) throw new Error("GOOGLE_SHEETS_ID_VACANCIES не указан");
    return id;
}

function extractVacancyId(url: string): string {
    const m = String(url || "").match(/\/vacancy\/(\d+)/);
    return m ? m[1] : "";
}

/** название первого листа реестра (обычно «Лист1») */
async function firstTabTitle(spreadsheetId: string): Promise<string> {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,index))" });
    const first = (meta.data.sheets || []).sort((a, b) => (a.properties?.index ?? 0) - (b.properties?.index ?? 0))[0];
    return first?.properties?.title || "Лист1";
}

export async function listRegistry(): Promise<{ tab: string; vacancies: RegistryVacancy[] }> {
    const sid = registryId();
    const tab = await firstTabTitle(sid);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${tab}!A2:H` });
    const rows = resp.data.values || [];
    const vacancies: RegistryVacancy[] = rows.map((row, idx) => {
        const c = (i: number) => String(row[i] ?? "").trim();
        const name = c(COL.name), hhUrl = c(COL.hhUrl), templatesUrl = c(COL.templatesUrl),
            responsible = c(COL.responsible), account = c(COL.account), stash = c(COL.stash);
        let status: VacancyStatus;
        if (name && hhUrl && templatesUrl && responsible && account) status = "active";
        else if (!account && stash && name && hhUrl) status = "disabled";
        else status = "draft";
        return {
            row: idx + 2,
            name,
            hhUrl,
            vacancyId: extractVacancyId(hhUrl),
            templatesUrl,
            responsible,
            // для отключённой показываем спрятанный аккаунт
            account: account || (status === "disabled" ? stash : ""),
            status,
            mode: parseVacancyMode(row[COL.mode]),
            workflow: parseWorkflowMode(row[COL.workflow], name),
        };
    }).filter((v) => v.name); // пустые строки не показываем
    return { tab, vacancies };
}

/** Меняет сценарий вакансии в колонке H реестра. */
export async function setVacancyWorkflow(
    row: number,
    workflow: WorkflowMode,
): Promise<{ ok: boolean; workflow?: WorkflowMode; error?: string }> {
    if (!Number.isInteger(row) || row < 2) return { ok: false, error: "неверный номер строки" };
    const sid = registryId();
    const tab = await firstTabTitle(sid);
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: sid,
        requestBody: {
            valueInputOption: "RAW",
            data: [
                { range: `${tab}!H1`, values: [["Сценарий обработки"]] },
                { range: `${tab}!H${row}`, values: [[workflowModeCell(workflow)]] },
            ],
        },
    });
    invalidatePrefix("registry:");
    return { ok: true, workflow };
}

/** Включить/отключить вакансию через перенос аккаунта HH между кол. E и резервной F. */
export async function setVacancyActive(row: number, active: boolean): Promise<{ ok: boolean; status?: VacancyStatus; error?: string }> {
    if (!Number.isInteger(row) || row < 2) return { ok: false, error: "неверный номер строки" };
    const sid = registryId();
    const tab = await firstTabTitle(sid);
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `${tab}!A${row}:F${row}` });
    const cur = resp.data.values?.[0] || [];
    const account = String(cur[COL.account] ?? "").trim();
    const stash = String(cur[COL.stash] ?? "").trim();
    const vacancyId = extractVacancyId(String(cur[COL.hhUrl] ?? ""));

    if (active) {
        // включаем: F → E
        const email = account || stash;
        if (!email) return { ok: false, error: "нет сохранённого аккаунта HH для включения" };
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sid,
            requestBody: {
                valueInputOption: "RAW",
                data: [
                    { range: `${tab}!E${row}`, values: [[email]] },
                    { range: `${tab}!F${row}`, values: [[""]] },
                ],
            },
        });
        invalidatePrefix("registry:");
        setRuntimeVacancyActive(vacancyId, true);
        return { ok: true, status: "active" };
    } else {
        // отключаем: E → F
        const email = account || stash;
        if (!email) return { ok: false, error: "у вакансии не заполнен аккаунт HH — нечего отключать" };
        // Сначала ставим локальный стоп: длинный проход прекращается сразу при
        // нажатии кнопки, не дожидаясь ответа Google Sheets.
        setRuntimeVacancyActive(vacancyId, false);
        try {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: sid,
                requestBody: {
                    valueInputOption: "RAW",
                    data: [
                        { range: `${tab}!E${row}`, values: [[""]] },
                        { range: `${tab}!F${row}`, values: [[email]] },
                    ],
                },
            });
        } catch (error) {
            // Запись не состоялась — реестр всё ещё активен. Старый проход всё
            // равно останется аннулированным по ревизии, новый сможет стартовать.
            setRuntimeVacancyActive(vacancyId, true);
            throw error;
        }
        invalidatePrefix("registry:");
        removePeriodStats(String(cur[COL.name] ?? ""));
        return { ok: true, status: "disabled" };
    }
}

/**
 * Переключить режим вакансии (колонка G).
 * Пишем понятные слова, а не флаги: таблицу читают и глазами.
 */
export async function setVacancyMode(
    row: number,
    mode: VacancyMode,
): Promise<{ ok: boolean; mode?: VacancyMode; error?: string }> {
    if (!Number.isInteger(row) || row < 2) return { ok: false, error: "неверный номер строки" };
    const sid = registryId();
    const tab = await firstTabTitle(sid);
    await sheets.spreadsheets.values.update({
        spreadsheetId: sid,
        range: `${tab}!G${row}`,
        valueInputOption: "RAW",
        requestBody: { values: [[mode === "live" ? "боевой" : "тест"]] },
    });
    // Реестр закэширован — сбрасываем, иначе бот подхватит режим только через 3 минуты.
    invalidatePrefix("registry:");
    return { ok: true, mode };
}

export interface NewVacancy {
    name: string;
    hhUrl: string;
    templatesUrl: string;
    responsible: string;
    account: string;
}

/** Добавить новую вакансию (полную строку) в реестр → станет активной. */
export async function createVacancy(v: NewVacancy): Promise<{ ok: boolean; row?: number; vacancyId?: string; error?: string }> {
    const name = String(v.name || "").trim();
    const hhUrl = String(v.hhUrl || "").trim();
    const templatesUrl = String(v.templatesUrl || "").trim();
    const responsible = String(v.responsible || "").trim();
    const account = normalizeAccountEmail(String(v.account || ""));
    if (!name || !hhUrl || !templatesUrl || !responsible || !account) {
        return { ok: false, error: "нужно заполнить все поля: название, HH-ссылка, таблица, ответственный, аккаунт" };
    }
    const vacancyId = extractVacancyId(hhUrl);
    if (!vacancyId) return { ok: false, error: "в HH-ссылке нет /vacancy/<id> — проверьте ссылку" };
    if (!/spreadsheets\/d\/[a-zA-Z0-9_-]+/.test(templatesUrl)) {
        return { ok: false, error: "ссылка на таблицу вакансии выглядит неверно" };
    }
    // аккаунт должен существовать среди подключённых
    const accounts = await listHhAccounts();
    if (!accounts.some((a) => normalizeAccountEmail(a.email) === account)) {
        return { ok: false, error: `аккаунт HH «${account}» не подключён` };
    }
    // дубль по vacancyId
    const { vacancies } = await listRegistry();
    if (vacancies.some((x) => x.vacancyId === vacancyId)) {
        return { ok: false, error: `вакансия ${vacancyId} уже есть в реестре` };
    }
    const sid = registryId();
    const tab = await firstTabTitle(sid);
    await sheets.spreadsheets.values.append({
        spreadsheetId: sid,
        range: `${tab}!A:H`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        // Новая вакансия заводится в тестовом режиме: сначала посмотреть разбор,
        // потом включить отправку кнопкой в панели.
        requestBody: { values: [[name, hhUrl, templatesUrl, responsible, account, "", "тест", "анкета"]] },
    });
    invalidatePrefix("registry:");
    return { ok: true, vacancyId };
}

/** Список подключённых HH-аккаунтов (для выпадающего списка). */
export async function listAccounts(): Promise<{ id: string; email: string }[]> {
    const accounts = await listHhAccounts();
    return accounts.map((a) => ({ id: a.id, email: a.email }));
}
