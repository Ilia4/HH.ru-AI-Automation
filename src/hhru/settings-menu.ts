import { Bot, Context, InlineKeyboard } from "grammy";
import { isAdminTelegramId } from "../auth/admin";
import {
    listRegistry,
    setVacancyActive,
    setVacancyMode,
    setVacancyWorkflow,
    type RegistryVacancy,
} from "../panel/registry";
import { listTopics } from "./topics.store";
import { extractSpreadsheetId } from "./sheets-analysis";
import {
    addFilter,
    deleteFilter,
    readEditableTemplates,
    readFilterSettings,
    setEditableTemplate,
    setMinimumScore,
    updateFilter,
    type TemplateKey,
    type VacancyFilter,
} from "./sheets-analysis";
import { applyDecision, getAllCandidates, type Candidate } from "../panel/data";
import { applyCandidateAnswerDecision, listPendingAnswers } from "./candidate-answers";

type View = { text: string; keyboard: InlineKeyboard };
type PendingInput = {
    type: "score" | "filter-new" | "filter-edit" | "filter-points-new" | "filter-points-edit" | "template";
    vacancyRow: number;
    menuMessageId: number;
    page?: number;
    filterRow?: number;
    draftText?: string;
    templateKey?: TemplateKey;
};

const pendingInputs = new Map<string, PendingInput>();
const FILTERS_PER_PAGE = 5;
const VACANCIES_PER_PAGE = 8;

const e = (value: unknown) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const short = (value: unknown, max = 500) => {
    const text = String(value ?? "").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const inputKey = (ctx: Context) => `${ctx.chat?.id || 0}:${ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id || 0}:${ctx.from?.id || 0}`;
const formatNumber = (n: number) => String(n).replace(".", ",");

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function allowed(ctx: Context): boolean {
    const groupId = String(process.env.GROUP_CHAT_ID || "").trim();
    return isAdminTelegramId(ctx.from?.id) || (!!groupId && String(ctx.chat?.id) === groupId);
}

function options(keyboard: InlineKeyboard) {
    return { parse_mode: "HTML" as const, reply_markup: keyboard, link_preview_options: { is_disabled: true } };
}

function stamped(view: View, ctx: Context): View {
    const user = ctx.from;
    if (!user) return view;
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || `ID ${user.id}`;
    const username = user.username ? ` (@${user.username})` : "";
    return {
        ...view,
        text: `${view.text}\n\n<i>👤 Последнее действие: ${e(name + username)}</i>`,
    };
}

async function show(ctx: Context, view: View): Promise<void> {
    view = stamped(view, ctx);
    if (ctx.callbackQuery?.message) {
        await ctx.editMessageText(view.text, options(view.keyboard)).catch(async (error: any) => {
            if (!String(error?.description || error?.message || "").includes("message is not modified")) throw error;
        });
    } else {
        await ctx.reply(view.text, { ...options(view.keyboard), message_thread_id: ctx.message?.message_thread_id });
    }
}

async function editInputMenu(ctx: Context, pending: PendingInput, view: View): Promise<void> {
    view = stamped(view, ctx);
    await ctx.api.editMessageText(ctx.chat!.id, pending.menuMessageId, view.text, options(view.keyboard));
}

async function vacancyByRow(row: number): Promise<RegistryVacancy | null> {
    const { vacancies } = await listRegistry();
    return vacancies.find((v) => v.row === row) || null;
}

async function contextualVacancy(threadId: number | undefined): Promise<RegistryVacancy | null> {
    if (!threadId) return null;
    const topics = listTopics();
    const { vacancies } = await listRegistry();
    // Идём по вакансиям, а не по темам: в topics.json встречаются повреждённые
    // дубли названий с тем же thread_id, их нужно просто пропустить.
    for (const vacancy of vacancies) {
        for (const [topicName, mappedId] of Object.entries(topics)) {
            if (Number(mappedId) === Number(threadId) && norm(topicName) === norm(vacancy.name)) return vacancy;
        }
    }
    return null;
}

async function registryView(requestedPage = 0): Promise<View> {
    const { vacancies } = await listRegistry();
    const pageCount = Math.max(1, Math.ceil(vacancies.length / VACANCIES_PER_PAGE));
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
    const visible = vacancies.slice(page * VACANCIES_PER_PAGE, (page + 1) * VACANCIES_PER_PAGE);
    const keyboard = new InlineKeyboard();
    for (const vacancy of visible) {
        const icon = vacancy.status === "active" ? "🟢" : vacancy.status === "disabled" ? "⏸" : "⚪️";
        keyboard.text(`${icon} ${short(vacancy.name, 48)}`, `cfg:v:${vacancy.row}`).row();
    }
    if (pageCount > 1) {
        if (page > 0) keyboard.text("⬅️", `cfg:l:${page - 1}`);
        keyboard.text(`${page + 1} / ${pageCount}`, `cfg:l:${page}`);
        if (page < pageCount - 1) keyboard.text("➡️", `cfg:l:${page + 1}`);
    }
    return {
        text: `<b>⚙️ НАСТРОЙКИ ВАКАНСИЙ</b>\n\nВыберите вакансию. В её Telegram-теме команда /settings откроет настройки сразу.`,
        keyboard,
    };
}

function workflowLabel(v: RegistryVacancy): string {
    return v.workflow === "chat_question" ? "Вопрос кандидату в HH" : "Анкета";
}

async function vacancyView(row: number): Promise<View> {
    const vacancy = await vacancyByRow(row);
    if (!vacancy) return registryView();
    const sid = extractSpreadsheetId(vacancy.templatesUrl);
    let minScore = 7, filters = 0;
    if (sid) {
        const cfg = await readFilterSettings(sid).catch(() => null);
        if (cfg) { minScore = cfg.minScore; filters = cfg.filters.length; }
    }
    const status = vacancy.status === "active" ? "🟢 Активна" : vacancy.status === "disabled" ? "⏸ Приостановлена" : "⚪️ Черновик";
    const sendMode = vacancy.mode === "live" ? "🟢 Боевой" : "🧪 Тестовый";
    const keyboard = new InlineKeyboard()
        .text("👥 Кандидаты, ожидающие решения", `cfg:c:${row}:0`).row()
        .text("🔄 Сценарий обработки", `cfg:w:${row}`).row()
        .text(vacancy.status === "active" ? "⏸ Приостановить" : "▶️ Активировать", `cfg:a:${row}`)
        .text(`Отправка: ${vacancy.mode === "live" ? "боевой" : "тест"}`, `cfg:m:${row}`).row()
        .text("⭐️ Проходной балл", `cfg:s:${row}`)
        .text("🔎 Фильтры", `cfg:f:${row}:0`).row()
        .text("📝 Шаблоны сообщений", `cfg:t:${row}`).row();
    if (/^https:\/\//i.test(vacancy.templatesUrl)) keyboard.url("Открыть Google-таблицу", vacancy.templatesUrl).row();
    keyboard.text("⬅️ Все вакансии", "cfg:l:0");
    return {
        text: [
            "<b>⚙️ НАСТРОЙКИ ВАКАНСИИ</b>", "",
            `<b>${e(vacancy.name)}</b>`, "",
            `Статус: ${status}`,
            `Сценарий: ${e(workflowLabel(vacancy))}`,
            `Отправка в HH: ${sendMode}`,
            `Проходной балл: <b>${formatNumber(minScore)}</b>`,
            `Фильтров: <b>${filters}</b>`,
        ].join("\n"), keyboard,
    };
}

async function workflowView(row: number): Promise<View> {
    const v = await vacancyByRow(row);
    if (!v) return registryView();
    return {
        text: [
            "<b>🔄 РЕЖИМ ОБРАБОТКИ</b>",
            "",
            `<b>${e(v.name)}</b>`,
            "",
            "Сейчас работает:",
            `<b>${v.workflow === "chat_question" ? "💬" : "📋"} ${e(workflowLabel(v))}</b>`,
            "",
            "📋 <b>Анкета</b> — после резюме кандидат получает приглашение заполнить анкету.",
            "",
            "💬 <b>Вопрос в HH</b> — кандидат отвечает прямо в переписке на HH.",
            "",
            "Выберите нужный режим:",
        ].join("\n"),
        keyboard: new InlineKeyboard()
            .text("📋 Анкета", `cfg:wp:${row}:q`).row()
            .text("💬 Вопрос кандидату в HH", `cfg:wp:${row}:c`).row()
            .text("📝 Шаблоны сообщений", `cfg:t:${row}`).row()
            .text("⬅️ Назад", `cfg:v:${row}`),
    };
}

async function workflowConfirmView(row: number, code: "q" | "c"): Promise<View> {
    const v = await vacancyByRow(row);
    if (!v) return registryView();
    const label = code === "c" ? "💬 Вопрос кандидату в HH" : "📋 Анкета";
    return {
        text: [
            "<b>🔄 СМЕНА РЕЖИМА</b>",
            "",
            `Новый режим: <b>${label}</b>`,
            "",
            "Текущие четыре шаблона можно оставить без изменений или сразу открыть их после переключения.",
        ].join("\n"),
        keyboard: new InlineKeyboard()
            .text("✅ Сменить, шаблоны оставить", `cfg:ws:${row}:${code}:k`).row()
            .text("✏️ Сменить и проверить шаблоны", `cfg:ws:${row}:${code}:e`).row()
            .text("⬅️ Назад", `cfg:w:${row}`),
    };
}

async function scoreInputView(row: number, error = ""): Promise<View> {
    const v = await vacancyByRow(row);
    let current = 7;
    if (v) {
        const sid = extractSpreadsheetId(v.templatesUrl);
        if (sid) current = (await readFilterSettings(sid).catch(() => ({ minScore: 7, filters: [] }))).minScore;
    }
    return {
        text: [
            "<b>⭐️ ПРОХОДНОЙ БАЛЛ</b>",
            "",
            v ? `<b>${e(v.name)}</b>` : "",
            "",
            `Сейчас установлен: <b>${formatNumber(current)} из 10</b>`,
            "",
            "Введите новое число от 0 до 10, например <code>7</code> или <code>7,5</code>.",
            ...(error ? ["", `⚠️ ${e(error)}`] : []),
        ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n"),
        keyboard: new InlineKeyboard().text("Отмена", `cfg:v:${row}`),
    };
}

function weightLabel(filter: VacancyFilter): string {
    if (filter.mode === "auto") return filter.direction === "minus" ? "Авто−" : "Авто+";
    const p = filter.points || 0;
    return `${p > 0 ? "+" : "−"}${formatNumber(Math.abs(p))}`;
}

async function filtersView(row: number, requestedPage = 0): Promise<View> {
    const v = await vacancyByRow(row);
    if (!v) return registryView();
    const sid = extractSpreadsheetId(v.templatesUrl);
    const cfg = await readFilterSettings(sid);
    const pageCount = Math.max(1, Math.ceil(cfg.filters.length / FILTERS_PER_PAGE));
    const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
    const visible = cfg.filters.slice(page * FILTERS_PER_PAGE, (page + 1) * FILTERS_PER_PAGE);
    const keyboard = new InlineKeyboard();
    for (const [offset, filter] of visible.entries()) {
        const number = page * FILTERS_PER_PAGE + offset + 1;
        keyboard.text(`Фильтр ${number}`, `cfg:fd:${row}:${filter.row}:${page}`).row();
    }
    if (pageCount > 1) {
        if (page > 0) keyboard.text("⬅️", `cfg:f:${row}:${page - 1}`);
        keyboard.text(`${page + 1} / ${pageCount}`, `cfg:f:${row}:${page}`);
        if (page < pageCount - 1) keyboard.text("➡️", `cfg:f:${row}:${page + 1}`);
        keyboard.row();
    }
    keyboard.text("➕ Добавить фильтр", `cfg:fa:${row}:${page}`).row().text("⬅️ Назад", `cfg:v:${row}`);
    const list = visible.length
        ? visible.map((f, i) => `<b>${page * FILTERS_PER_PAGE + i + 1}. [${weightLabel(f)}]</b> ${e(short(f.text, 240))}`).join("\n\n")
        : "Фильтров пока нет.";
    return {
        text: [
            "<b>🔎 ФИЛЬТРЫ</b>",
            "",
            list,
            "",
            "Нажмите «Фильтр N», чтобы открыть его полностью, изменить вес, текст или удалить.",
            "",
            "Авто+/Авто− — влияние определяет ИИ. Фиксированный вес прибавляется или вычитается точно.",
        ].join("\n"),
        keyboard,
    };
}

async function filterDetailView(vacancyRow: number, filterRow: number, page = 0): Promise<View> {
    const v = await vacancyByRow(vacancyRow);
    if (!v) return registryView();
    const cfg = await readFilterSettings(extractSpreadsheetId(v.templatesUrl));
    const filter = cfg.filters.find((f) => f.row === filterRow);
    if (!filter) return filtersView(vacancyRow, page);
    return {
        text: `<b>🔎 ФИЛЬТР</b>\n\n${e(filter.text)}\n\nВес: <b>${weightLabel(filter)}</b>`,
        keyboard: new InlineKeyboard()
            .text("✏️ Изменить текст", `cfg:fe:${vacancyRow}:${filterRow}:${page}`).row()
            .text("Авто+", `cfg:fw:${vacancyRow}:${filterRow}:ap:${page}`)
            .text("Авто−", `cfg:fw:${vacancyRow}:${filterRow}:am:${page}`).row()
            .text("⚖️ Точный вес", `cfg:fp:${vacancyRow}:${filterRow}:${page}`).row()
            .text("🗑 Удалить", `cfg:fdq:${vacancyRow}:${filterRow}:${page}`).row()
            .text("⬅️ Назад", `cfg:f:${vacancyRow}:${page}`),
    };
}

function filterTextInputView(row: number, title: string, back: string, error = ""): View {
    return {
        text: `<b>${e(title)}</b>\n\nВведите текст фильтра одним сообщением (до 500 символов).${error ? `\n\n⚠️ ${e(error)}` : ""}`,
        keyboard: new InlineKeyboard().text("Отмена", back),
    };
}

function filterWeightView(row: number): View {
    return {
        text: `<b>⚖️ ВЕС НОВОГО ФИЛЬТРА</b>\n\nВыберите, как фильтр влияет на итоговый балл.`,
        keyboard: new InlineKeyboard()
            .text("Авто+", `cfg:fn:${row}:ap`).text("Авто−", `cfg:fn:${row}:am`).row()
            .text("⚖️ Указать точный вес", `cfg:fn:${row}:fx`).row()
            .text("Отмена", `cfg:f:${row}:0`),
    };
}

function pointsInputView(row: number, error = ""): View {
    return {
        text: `<b>⚖️ ТОЧНЫЙ ВЕС</b>\n\nВведите число от −10 до +10, кроме нуля. Например: <code>+2</code> или <code>-1,5</code>.${error ? `\n\n⚠️ ${e(error)}` : ""}`,
        keyboard: new InlineKeyboard().text("Отмена", `cfg:f:${row}:0`),
    };
}

const TEMPLATE_CODES: Record<string, TemplateKey> = { rs: "resume_success", rr: "resume_reject", ss: "stage_success", sr: "stage_reject" };
const TEMPLATE_CODE_BY_KEY: Record<TemplateKey, string> = { resume_success: "rs", resume_reject: "rr", stage_success: "ss", stage_reject: "sr" };
function templateLabels(v: RegistryVacancy): Record<TemplateKey, string> {
    return v.workflow === "chat_question" ? {
        resume_success: "После резюме: вопрос в HH", resume_reject: "Отказ после резюме",
        stage_success: "После ответа: приглашение", stage_reject: "Отказ после ответа",
    } : {
        resume_success: "После резюме: приглашение в анкету", resume_reject: "Отказ после резюме",
        stage_success: "После анкеты: приглашение", stage_reject: "Отказ после анкеты",
    };
}

async function templatesView(row: number): Promise<View> {
    const v = await vacancyByRow(row);
    if (!v) return registryView();
    const templates = await readEditableTemplates(extractSpreadsheetId(v.templatesUrl));
    const labels = templateLabels(v);
    const keyboard = new InlineKeyboard();
    for (const t of templates) keyboard.text(`${t.text ? "✅" : "⚠️"} ${labels[t.key]}`, `cfg:te:${row}:${TEMPLATE_CODE_BY_KEY[t.key]}`).row();
    keyboard.text("⬅️ Назад", `cfg:v:${row}`);
    return { text: `<b>📝 ШАБЛОНЫ СООБЩЕНИЙ</b>\n\nСценарий: <b>${e(workflowLabel(v))}</b>\n\n✅ заполнен · ⚠️ пустой`, keyboard };
}

async function templateDetailView(row: number, key: TemplateKey): Promise<View> {
    const v = await vacancyByRow(row);
    if (!v) return registryView();
    const template = (await readEditableTemplates(extractSpreadsheetId(v.templatesUrl))).find((t) => t.key === key);
    const label = templateLabels(v)[key];
    return {
        text: `<b>📝 ${e(label.toUpperCase())}</b>\n\n${template?.text ? e(short(template.text, 2500)) : "⚠️ Шаблон пока пуст."}\n\nМожно использовать <code>[Name]</code> и <code>[Vacancy]</code>.`,
        keyboard: new InlineKeyboard().text("✏️ Изменить", `cfg:ti:${row}:${TEMPLATE_CODE_BY_KEY[key]}`).row().text("⬅️ Назад", `cfg:t:${row}`),
    };
}

type PendingCandidate = {
    kind: "resume" | "anketa" | "answer";
    row: number;
    fio: string;
    resumeId: string;
    resumeUrl: string;
    score: string;
    summary: string;
    candidateText?: string;
};

async function pendingCandidates(v: RegistryVacancy): Promise<PendingCandidate[]> {
    if (v.status !== "active") return [];
    const candidates = (await getAllCandidates()).filter((c) => c.vacancyId === v.vacancyId);
    const out: PendingCandidate[] = [];
    for (const c of candidates) {
        if (norm(c.resume?.status) === norm("Ручная проверка") && c.resumeRow) {
            out.push({ kind: "resume", row: c.resumeRow, fio: c.fio, resumeId: c.resumeId, resumeUrl: c.resumeUrl, score: c.resume?.score || "", summary: c.resume?.comment || "" });
        }
        const action = norm(c.anketa?.hrAction);
        if (v.workflow === "questionnaire" && c.anketa?.filled && (!action || action === norm("Ожидание")) && !c.anketa.sent && c.anketaRow) {
            out.push({ kind: "anketa", row: c.anketaRow, fio: c.fio, resumeId: c.resumeId, resumeUrl: c.resumeUrl, score: c.anketa.score || "", summary: c.anketa.conclusion || "" });
        }
    }
    if (v.workflow === "chat_question") {
        const sid = extractSpreadsheetId(v.templatesUrl);
        for (const answer of await listPendingAnswers(sid)) {
            const resumeId = answer.resumeUrl.match(/\/resume\/([^?#/]+)/i)?.[1] || "";
            out.push({ kind: "answer", row: answer.rowNumber, fio: answer.fio || "(без ФИО)", resumeId, resumeUrl: answer.resumeUrl, score: "", summary: "", candidateText: answer.text });
        }
    }
    return out;
}

const kindLabel = (kind: PendingCandidate["kind"]) => kind === "resume" ? "Ручная проверка резюме" : kind === "anketa" ? "Решение по анкете" : "Решение по ответу в HH";
const kindCode = (kind: PendingCandidate["kind"]) => kind === "resume" ? "r" : kind === "anketa" ? "q" : "h";
const kindByCode = (code: string): PendingCandidate["kind"] => code === "r" ? "resume" : code === "q" ? "anketa" : "answer";

async function candidateView(row: number, requestedIndex = 0): Promise<View> {
    const v = await vacancyByRow(row);
    if (!v) return registryView();
    const queue = await withTimeout(
        pendingCandidates(v),
        25_000,
        "Google-таблицы отвечают слишком долго. Попробуйте открыть кандидатов ещё раз через минуту.",
    );
    if (!queue.length) return { text: `<b>👥 КАНДИДАТЫ</b>\n\nПо вакансии «${e(v.name)}» сейчас нет решений, ожидающих HR.`, keyboard: new InlineKeyboard().text("⬅️ Назад", `cfg:v:${row}`) };
    const index = Math.max(0, Math.min(requestedIndex, queue.length - 1));
    const c = queue[index];
    const bodyTitle = c.kind === "answer" ? "💬 Сообщение кандидата" : "🤖 Заключение ИИ";
    const bodyText = c.kind === "answer" ? c.candidateText : (c.summary || "Заключение не указано");
    const keyboard = new InlineKeyboard()
        .text("✅ Подходит", `cfg:cd:${row}:${kindCode(c.kind)}:${c.row}:a:${index}`)
        .text("❌ Отказ", `cfg:cd:${row}:${kindCode(c.kind)}:${c.row}:r:${index}`).row();
    if (c.resumeUrl) keyboard.url("🔗 Резюме кандидата на HH", c.resumeUrl).row();
    if (queue.length > 1) {
        if (index > 0) keyboard.text("⬅️", `cfg:c:${row}:${index - 1}`);
        keyboard.text(`${index + 1} из ${queue.length}`, `cfg:c:${row}:${index}`);
        if (index < queue.length - 1) keyboard.text("➡️", `cfg:c:${row}:${index + 1}`);
        keyboard.row();
    }
    keyboard.text("⬅️ К настройкам", `cfg:v:${row}`);
    return {
        text: [
            "<b>👥 КАНДИДАТ НА РЕШЕНИЕ</b>",
            "",
            `👤 <b>Кандидат:</b> ${e(c.fio)}`,
            `💼 <b>Вакансия:</b> ${e(v.name)}`,
            `📍 <b>Этап:</b> ${e(kindLabel(c.kind))}`,
            ...(c.score ? [`⭐️ <b>Балл:</b> ${e(c.score)} из 10`] : []),
            "",
            `<b>${bodyTitle}</b>`,
            `<blockquote>${e(short(bodyText, 1600))}</blockquote>`,
            "",
            `<i>Ожидают решения: ${queue.length}. Выберите «Подходит» или «Отказ».</i>`,
        ].join("\n"),
        keyboard,
    };
}

async function candidateConfirmView(vacancyRow: number, kindCode: string, candidateRow: number, decision: string, index: number): Promise<View> {
    const v = await vacancyByRow(vacancyRow);
    if (!v) return registryView();
    const kind = kindByCode(kindCode);
    const candidate = (await withTimeout(
        pendingCandidates(v),
        25_000,
        "Google-таблицы отвечают слишком долго. Попробуйте ещё раз через минуту.",
    )).find((c) => c.kind === kind && c.row === candidateRow);
    if (!candidate) return candidateView(vacancyRow, index);
    const value = decision === "a" ? "Подходит" : (kind === "anketa" ? "Не подходит" : "Отказ");
    return {
        text: `<b>ПОДТВЕРДИТЕ РЕШЕНИЕ</b>\n\nКандидат: <b>${e(candidate.fio)}</b>\nРешение: <b>${e(value)}</b>\n\nСтатус будет записан в Google-таблицу. Действие в HH выполнит штатный цикл с проверкой повторов.`,
        keyboard: new InlineKeyboard().text("Подтвердить", `cfg:cc:${vacancyRow}:${kindCode}:${candidateRow}:${decision}:${index}`).row().text("Отмена", `cfg:c:${vacancyRow}:${index}`),
    };
}

async function handleInput(ctx: Context, pending: PendingInput): Promise<void> {
    const text = String(ctx.message?.text || "").trim();
    const v = await vacancyByRow(pending.vacancyRow);
    if (!v) throw new Error("Вакансия не найдена");
    const sid = extractSpreadsheetId(v.templatesUrl);
    if (pending.type === "score") {
        const value = Number(text.replace(",", "."));
        if (!Number.isFinite(value) || value < 0 || value > 10) {
            await editInputMenu(ctx, pending, await scoreInputView(v.row, "Нужно число от 0 до 10.")); return;
        }
        await setMinimumScore(sid, Math.round(value * 10) / 10);
        pendingInputs.delete(inputKey(ctx));
        await editInputMenu(ctx, pending, await vacancyView(v.row));
    } else if (pending.type === "filter-new" || pending.type === "filter-edit") {
        const value = text.replace(/\s+/g, " ").trim();
        if (!value || value.length > 500) {
            await editInputMenu(ctx, pending, filterTextInputView(v.row, pending.type === "filter-new" ? "НОВЫЙ ФИЛЬТР" : "ИЗМЕНИТЬ ФИЛЬТР", `cfg:f:${v.row}:${pending.page || 0}`, "Нужно от 1 до 500 символов.")); return;
        }
        if (pending.type === "filter-edit") {
            const cfg = await readFilterSettings(sid);
            const old = cfg.filters.find((f) => f.row === pending.filterRow);
            if (!old) throw new Error("Фильтр не найден");
            await updateFilter(sid, old.row, { text: value, mode: old.mode, direction: old.direction, points: old.points });
            pendingInputs.delete(inputKey(ctx));
            await editInputMenu(ctx, pending, await filterDetailView(v.row, old.row, pending.page || 0));
        } else {
            pending.draftText = value;
            pendingInputs.set(inputKey(ctx), pending);
            await editInputMenu(ctx, pending, filterWeightView(v.row));
        }
    } else if (pending.type === "filter-points-new" || pending.type === "filter-points-edit") {
        const value = Number(text.replace(",", ".").replace("−", "-"));
        if (!Number.isFinite(value) || value === 0 || value < -10 || value > 10) {
            await editInputMenu(ctx, pending, pointsInputView(v.row, "Нужно число от −10 до +10, кроме нуля.")); return;
        }
        if (pending.type === "filter-points-new") {
            await addFilter(sid, { text: pending.draftText || "", mode: "fixed", direction: value < 0 ? "minus" : "plus", points: Math.round(value * 10) / 10 });
            pendingInputs.delete(inputKey(ctx));
            await editInputMenu(ctx, pending, await filtersView(v.row, pending.page || 0));
        } else {
            const cfg = await readFilterSettings(sid);
            const old = cfg.filters.find((f) => f.row === pending.filterRow);
            if (!old) throw new Error("Фильтр не найден");
            await updateFilter(sid, old.row, { text: old.text, mode: "fixed", direction: value < 0 ? "minus" : "plus", points: Math.round(value * 10) / 10 });
            pendingInputs.delete(inputKey(ctx));
            await editInputMenu(ctx, pending, await filterDetailView(v.row, old.row, pending.page || 0));
        }
    } else if (pending.type === "template") {
        if (!text || text.length > 3000 || !pending.templateKey) {
            throw new Error("Шаблон должен содержать от 1 до 3000 символов");
        }
        await setEditableTemplate(sid, pending.templateKey, text);
        pendingInputs.delete(inputKey(ctx));
        await editInputMenu(ctx, pending, await templateDetailView(v.row, pending.templateKey));
    }
    await ctx.deleteMessage().catch(() => undefined);
}

export function registerVacancySettingsMenu(bot: Bot): void {
    bot.command(["settings", "setting", "seting"], async (ctx) => {
        if (!allowed(ctx)) { if (ctx.chat.type === "private") await ctx.reply("Настройки доступны только администраторам и в рабочей группе."); return; }
        pendingInputs.delete(inputKey(ctx));
        const vacancy = await contextualVacancy(ctx.message?.message_thread_id);
        await show(ctx, vacancy ? await vacancyView(vacancy.row) : await registryView());
    });

    bot.callbackQuery(/^cfg:/, async (ctx) => {
        if (!allowed(ctx)) { await ctx.answerCallbackQuery({ text: "Доступ закрыт", show_alert: true }); return; }
        const parts = String(ctx.callbackQuery.data).split(":");
        const action = parts[1];
        try {
            let view: View;
            if (action === "l") view = await registryView(Number(parts[2]) || 0);
            else if (action === "v") view = await vacancyView(Number(parts[2]));
            else if (action === "a") {
                const v = await vacancyByRow(Number(parts[2]));
                if (!v) throw new Error("Вакансия не найдена");
                const result = await setVacancyActive(v.row, v.status !== "active");
                if (!result.ok) throw new Error(result.error);
                view = await vacancyView(v.row);
            } else if (action === "m") {
                const v = await vacancyByRow(Number(parts[2]));
                if (!v) throw new Error("Вакансия не найдена");
                await setVacancyMode(v.row, v.mode === "live" ? "test" : "live");
                view = await vacancyView(v.row);
            } else if (action === "w") view = await workflowView(Number(parts[2]));
            else if (action === "wp") view = await workflowConfirmView(Number(parts[2]), parts[3] === "c" ? "c" : "q");
            else if (action === "ws") {
                const row = Number(parts[2]);
                await setVacancyWorkflow(row, parts[3] === "c" ? "chat_question" : "questionnaire");
                view = parts[4] === "e" ? await templatesView(row) : await vacancyView(row);
            } else if (action === "s") {
                const row = Number(parts[2]); view = await scoreInputView(row);
                pendingInputs.set(inputKey(ctx), { type: "score", vacancyRow: row, menuMessageId: ctx.callbackQuery.message!.message_id });
            } else if (action === "f") view = await filtersView(Number(parts[2]), Number(parts[3]) || 0);
            else if (action === "fa") {
                const row = Number(parts[2]), page = Number(parts[3]) || 0;
                view = filterTextInputView(row, "НОВЫЙ ФИЛЬТР", `cfg:f:${row}:${page}`);
                pendingInputs.set(inputKey(ctx), { type: "filter-new", vacancyRow: row, page, menuMessageId: ctx.callbackQuery.message!.message_id });
            } else if (action === "fd") view = await filterDetailView(Number(parts[2]), Number(parts[3]), Number(parts[4]) || 0);
            else if (action === "fe") {
                const row = Number(parts[2]), filterRow = Number(parts[3]), page = Number(parts[4]) || 0;
                view = filterTextInputView(row, "ИЗМЕНИТЬ ФИЛЬТР", `cfg:fd:${row}:${filterRow}:${page}`);
                pendingInputs.set(inputKey(ctx), { type: "filter-edit", vacancyRow: row, filterRow, page, menuMessageId: ctx.callbackQuery.message!.message_id });
            } else if (action === "fw") {
                const row = Number(parts[2]), filterRow = Number(parts[3]), page = Number(parts[5]) || 0;
                const v = await vacancyByRow(row); if (!v) throw new Error("Вакансия не найдена");
                const cfg = await readFilterSettings(extractSpreadsheetId(v.templatesUrl));
                const old = cfg.filters.find((f) => f.row === filterRow); if (!old) throw new Error("Фильтр не найден");
                const direction = parts[4] === "am" ? "minus" : "plus";
                await updateFilter(extractSpreadsheetId(v.templatesUrl), filterRow, { text: old.text, mode: "auto", direction, points: null });
                view = await filterDetailView(row, filterRow, page);
            } else if (action === "fp") {
                const row = Number(parts[2]), filterRow = Number(parts[3]), page = Number(parts[4]) || 0;
                view = pointsInputView(row);
                pendingInputs.set(inputKey(ctx), { type: "filter-points-edit", vacancyRow: row, filterRow, page, menuMessageId: ctx.callbackQuery.message!.message_id });
            } else if (action === "fn") {
                const row = Number(parts[2]);
                const pending = pendingInputs.get(inputKey(ctx));
                if (!pending?.draftText) throw new Error("Сначала введите текст фильтра");
                if (parts[3] === "fx") {
                    pending.type = "filter-points-new"; pendingInputs.set(inputKey(ctx), pending); view = pointsInputView(row);
                } else {
                    const v = await vacancyByRow(row); if (!v) throw new Error("Вакансия не найдена");
                    await addFilter(extractSpreadsheetId(v.templatesUrl), { text: pending.draftText, mode: "auto", direction: parts[3] === "am" ? "minus" : "plus", points: null });
                    pendingInputs.delete(inputKey(ctx)); view = await filtersView(row, pending.page || 0);
                }
            } else if (action === "fdq") {
                const row = Number(parts[2]), filterRow = Number(parts[3]), page = Number(parts[4]) || 0;
                view = { text: "<b>Удалить этот фильтр?</b>\n\nДругие колонки и строки таблицы не изменятся.", keyboard: new InlineKeyboard().text("Удалить", `cfg:fdy:${row}:${filterRow}:${page}`).row().text("Отмена", `cfg:fd:${row}:${filterRow}:${page}`) };
            } else if (action === "fdy") {
                const row = Number(parts[2]), page = Number(parts[4]) || 0;
                const v = await vacancyByRow(row); if (!v) throw new Error("Вакансия не найдена");
                await deleteFilter(extractSpreadsheetId(v.templatesUrl), Number(parts[3])); view = await filtersView(row, page);
            } else if (action === "t") view = await templatesView(Number(parts[2]));
            else if (action === "te") {
                const key = TEMPLATE_CODES[parts[3]]; if (!key) throw new Error("Шаблон не найден");
                view = await templateDetailView(Number(parts[2]), key);
            } else if (action === "ti") {
                const row = Number(parts[2]), key = TEMPLATE_CODES[parts[3]]; if (!key) throw new Error("Шаблон не найден");
                view = { text: "<b>📝 НОВЫЙ ТЕКСТ ШАБЛОНА</b>\n\nОтправьте текст одним сообщением. Можно использовать <code>[Name]</code> и <code>[Vacancy]</code>.", keyboard: new InlineKeyboard().text("Отмена", `cfg:te:${row}:${parts[3]}`) };
                pendingInputs.set(inputKey(ctx), { type: "template", vacancyRow: row, templateKey: key, menuMessageId: ctx.callbackQuery.message!.message_id });
            } else if (action === "c") view = await candidateView(Number(parts[2]), Number(parts[3]) || 0);
            else if (action === "cd") view = await candidateConfirmView(Number(parts[2]), parts[3], Number(parts[4]), parts[5], Number(parts[6]) || 0);
            else if (action === "cc") {
                const row = Number(parts[2]), kindCode = parts[3], candidateRow = Number(parts[4]), decision = parts[5], index = Number(parts[6]) || 0;
                const v = await vacancyByRow(row); if (!v) throw new Error("Вакансия не найдена");
                const kind = kindByCode(kindCode);
                const candidate = (await withTimeout(
                    pendingCandidates(v),
                    25_000,
                    "Google-таблицы отвечают слишком долго. Решение не записано — попробуйте ещё раз.",
                )).find((c) => c.kind === kind && c.row === candidateRow);
                if (!candidate) throw new Error("Карточка уже обработана");
                if (kind === "answer") {
                    const result = await applyCandidateAnswerDecision(extractSpreadsheetId(v.templatesUrl), decision === "a" ? "Подходит" : "Отказ", { row: candidate.row, resumeId: candidate.resumeId, fio: candidate.fio });
                    if (!result.ok) throw new Error(result.error);
                } else {
                    const value = decision === "a" ? "Подходит" : kind === "anketa" ? "Не подходит" : "Отказ";
                    const result = await applyDecision(v.vacancyId, kind, value, { row: candidate.row, resumeId: candidate.resumeId, fio: candidate.fio });
                    if (!result.ok) throw new Error(result.error);
                }
                view = await candidateView(row, index);
            } else throw new Error("Неизвестная команда меню");
            await show(ctx, view);
            await ctx.answerCallbackQuery().catch(() => undefined);
        } catch (error: any) {
            console.error("[settings]", error?.message || error);
            await ctx.answerCallbackQuery({ text: short(error?.message || "Ошибка настройки", 180), show_alert: true }).catch(() => undefined);
        }
    });

    bot.on("message:text", async (ctx, next) => {
        const pending = pendingInputs.get(inputKey(ctx));
        if (!pending) return next();
        if (!allowed(ctx)) return next();
        try { await handleInput(ctx, pending); }
        catch (error: any) {
            console.error("[settings-input]", error?.message || error);
            await ctx.reply(`Не удалось сохранить: ${String(error?.message || error)}`);
        }
    });
}
