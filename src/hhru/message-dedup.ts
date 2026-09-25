/**
 * Дедуп отправок кандидату: определяем СМЫСЛ сообщения работодателя, чтобы не отправить
 * повторно то, что уже есть в чате (неважно — прислал бот или руководитель вручную).
 *
 * Категории (по реальным шаблонам «Автоответы»):
 *   reject          — отказ. ОДИН и тот же на стадии резюме и анкеты
 *                     («К сожалению … не готовы пригласить … на дальнейшее интервью»).
 *   anketa_invite   — приглашение заполнить анкету/форму (ссылка на forms) — стадия резюме.
 *   interview_invite— приглашение на собеседование в офис — стадия анкеты.
 *
 * ВАЖНО: текст отказа содержит слова «пригласить»/«интервью», поэтому reject проверяем
 * ПЕРВЫМ, иначе отказ ошибочно распознается как приглашение.
 */
export type MsgCategory = "reject" | "anketa_invite" | "interview_invite";

interface Msg {
    author?: { participant_type?: string };
    text?: string;
}

/** Категория сообщения работодателя, либо null если не распознали. Порядок важен. */
export function detectCategory(text: string): MsgCategory | null {
    const t = String(text || "").toLowerCase().replace(/ё/g, "е");

    // 1) ОТКАЗ — первым (в тексте отказа есть «пригласить»/«интервью»)
    if (/к сожалению/.test(t) && /(не готов|не смож|отказ|не подош|не подходит|в другой раз|остановил|выбрал)/.test(t)) return "reject";
    if (/вынуждены отказать|отказываем в|к сожалению.{0,40}отказ|не будем продолжать/.test(t)) return "reject";

    // 2) АНКЕТА-ИНВАЙТ — ссылка на форму или «заполните анкету/форму» (будущее время)
    if (/forms\.gle|docs\.google\.com\/forms|forms\/d\//.test(t)) return "anketa_invite";
    // NB: без \b — в JS граница слова не работает после кириллицы, паттерн был мёртвым
    // и приглашения «заполните … анкету» (без ссылки на forms) не распознавались.
    if (/заполни(те|ть)[\s\S]{0,40}(анкет|форм)/.test(t)) return "anketa_invite";
    // Приглашение-«первичный контакт» этой компании: «изучите описание вакансии … и заполните анкету»
    if (/изучите описание вакансии[\s\S]{0,80}анкет/.test(t)) return "anketa_invite";
    if (/(просим|нужно|надо)\s+заполнить\s+анкет/.test(t)) return "anketa_invite";

    // 3) СОБЕСЕДОВАНИЕ-ИНВАЙТ — «пригласить на собеседование … офис/адрес» (не отказ)
    if (/(пригласить|приглаша|хотели бы|хотим|приглашаем)[\s\S]{0,40}собеседован/.test(t)) return "interview_invite";
    if (/собеседован[\s\S]{0,40}(офис|адрес|по адресу|созвон|видео)/.test(t)) return "interview_invite";

    return null;
}

/** Уже есть сообщение работодателя нужной категории (ручное ИЛИ ботом) → отправлять не нужно. */
export function employerAlreadySent(messages: Msg[], category: MsgCategory): boolean {
    for (const m of messages || []) {
        if (m?.author?.participant_type !== "employer") continue;
        if (detectCategory(m.text || "") === category) return true;
    }
    return false;
}

/** Какая категория соответствует решению HR. */
export function categoryForDecision(decision: string, stage: "resume" | "anketa"): MsgCategory | null {
    const d = String(decision || "").trim().toLowerCase();
    if (d === "отказ" || d === "не подходит") return "reject";
    if (d === "подходит") return stage === "resume" ? "anketa_invite" : "interview_invite";
    return null;
}

/**
 * Нужно ли ПРОПУСТИТЬ отправку сообщения категории `intended`:
 *  1) такое же сообщение уже есть в чате (бот или вручную) — не дублируем;
 *  2) приглашаем (анкета/собеседование) ПОВЕРХ уже отправленного отказа — не противоречим
 *     (случай «отказали, потом прислали анкету»).
 */
export function shouldSkipSend(messages: Msg[], intended: MsgCategory): { skip: boolean; reason: string } {
    if (employerAlreadySent(messages, intended)) {
        return { skip: true, reason: intended === "reject" ? "отказ уже был в чате" : "приглашение уже было в чате" };
    }
    const isInvite = intended === "anketa_invite" || intended === "interview_invite";
    if (isInvite && employerAlreadySent(messages, "reject")) {
        return { skip: true, reason: "в чате уже есть ОТКАЗ — не приглашаем поверх отказа" };
    }
    return { skip: false, reason: "" };
}

/** Есть ли в чате хоть какое-то решение работодателя (отказ/приглашение) — «уже обработан». */
export function hasAnyDecision(messages: Msg[]): boolean {
    return (messages || []).some((m) => m?.author?.participant_type === "employer" && detectCategory(m.text || "") !== null);
}
