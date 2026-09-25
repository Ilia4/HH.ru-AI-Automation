/**
 * Метки кандидата в сообщениях Telegram и ссылка на его карточку в панели.
 *
 * Зачем: в теме вакансии сообщения по всем кандидатам идут одной лентой,
 * и собрать переписку по одному человеку было нечем. Telegram своей
 * группировки внутри темы не даёт, но умеет хэштеги: клик по #Фамилия_Имя
 * показывает все сообщения с этой меткой.
 *
 * Кнопка в панель добавляется не к каждому сообщению, а изредка — иначе она
 * превращается в шум и её перестают замечать.
 */
import { InlineKeyboard } from "grammy";
import { escapeTelegramHtml, resumeLinkHtml } from "./telegram-cards";

/** Каждое N-е сообщение по вакансии получает кнопку «Открыть карточку». */
const BUTTON_EVERY = Number(process.env.PANEL_BUTTON_EVERY || 10);

/** Публичный адрес панели. Без него кнопку просто не показываем. */
function panelBase(): string {
    return String(process.env.PANEL_PUBLIC_URL || "").replace(/\/+$/, "");
}

/**
 * «Богомолова Елена Юрьевна» → «#Богомолова_Елена_Юрьевна».
 * Хэштеги Telegram не терпят пробелов и знаков препинания, поэтому оставляем
 * только буквы и цифры, а пробелы превращаем в подчёркивания.
 */
export function candidateHashtag(fullName: string): string {
    const cleaned = String(fullName || "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join("_");
    return cleaned ? `#${cleaned}` : "";
}

/** id резюме из ссылки вида https://hh.ru/resume/<id>?t=<negotiation> */
export function resumeIdFromUrl(url: string): string {
    return String(url || "").match(/resume\/([^?#/]+)/)?.[1] || "";
}

/** Прямая ссылка на карточку кандидата в панели. */
export function candidateCardUrl(vacancyId: string, resumeUrl: string): string {
    const base = panelBase();
    const resumeId = resumeIdFromUrl(resumeUrl);
    if (!base || !vacancyId || !resumeId) return "";
    return `${base}/?card=${encodeURIComponent(vacancyId)}:${encodeURIComponent(resumeId)}`;
}

// Счётчик сообщений по теме вакансии. В памяти: точность здесь не важна,
// важно лишь не показывать кнопку слишком часто.
const counters = new Map<string, number>();

/** Пора ли показать кнопку: каждое N-е сообщение по этой вакансии. */
export function shouldShowPanelButton(vacancyName: string): boolean {
    if (BUTTON_EVERY <= 0) return false;
    const key = String(vacancyName || "—");
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return next % BUTTON_EVERY === 0;
}

export interface TagOptions {
    vacancyName: string;
    vacancyId?: string;
    candidateName: string;
    resumeUrl?: string;
    /** Текст уже собран безопасным HTML-форматтером. Иначе он экранируется целиком. */
    html?: boolean;
}

/**
 * Дополняет текст сообщения меткой кандидата и, изредка, приглашением в панель.
 * Возвращает готовые текст и клавиатуру — вызывающему коду остаётся отправить.
 */
export function decorate(text: string, opts: TagOptions): { text: string; keyboard?: InlineKeyboard } {
    const tag = candidateHashtag(opts.candidateName);
    const body = opts.html ? text : escapeTelegramHtml(text);
    const url = candidateCardUrl(String(opts.vacancyId || ""), String(opts.resumeUrl || ""));
    const showPanelButton = Boolean(url && shouldShowPanelButton(opts.vacancyName));
    const footer = [
        // Оставляем обычным текстом: Telegram делает такой хэштег кликабельным.
        tag ? escapeTelegramHtml(tag) : "",
        resumeLinkHtml(opts.resumeUrl),
    ].filter(Boolean);
    const panelHint = showPanelButton
        ? "💡 Подробнее — в карточке кандидата: оценка резюме, ответы и вся переписка."
        : "";
    const parts = [body, panelHint, footer.join("\n")].filter(Boolean);
    const withTag = parts.join("\n\n");
    if (!showPanelButton) return { text: withTag };

    return {
        text: withTag,
        keyboard: new InlineKeyboard().url("Открыть карточку кандидата", url),
    };
}
