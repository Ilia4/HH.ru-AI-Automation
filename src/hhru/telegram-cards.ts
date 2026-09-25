/** Единое безопасное HTML-оформление уведомлений о кандидатах в Telegram. */

export type CandidateStage = "Анализ резюме" | "Анализ анкеты" | "Собеседование";

export function escapeTelegramHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Разрешаем только настоящие ссылки на резюме в доменах HH. */
export function safeHhResumeUrl(value: unknown): string {
    try {
        const url = new URL(String(value || "").trim());
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" && url.protocol !== "http:") return "";
        if (host !== "hh.ru" && !host.endsWith(".hh.ru")) return "";
        if (!url.pathname.includes("/resume/")) return "";
        return url.toString();
    } catch {
        return "";
    }
}

export function resumeLinkHtml(resumeUrl: unknown): string {
    const safe = safeHhResumeUrl(resumeUrl);
    return safe ? `🔗 <a href="${escapeTelegramHtml(safe)}">Резюме кандидата</a>` : "";
}

export interface CandidateCardField {
    icon: string;
    label: string;
    value: unknown;
}

export interface CandidateCardOptions {
    header: string;
    candidateName: string;
    vacancyName: string;
    stage: CandidateStage;
    fields?: CandidateCardField[];
    quoteLabel?: string;
    quote?: string;
    details?: string[];
    action?: string;
}

/**
 * Карточка без метаданных внизу. Хэштег, ссылка на резюме и редкая кнопка
 * панели добавляются централизованно функцией decorate(..., { html: true }).
 */
export function buildCandidateCard(options: CandidateCardOptions): string {
    const blocks: string[] = [`<b>${escapeTelegramHtml(options.header)}</b>`];
    const info = [
        `👤 <b>Кандидат:</b> ${escapeTelegramHtml(options.candidateName)}`,
        `💼 <b>Вакансия:</b> ${escapeTelegramHtml(options.vacancyName)}`,
        ...(options.fields || []).map((field) =>
            `${escapeTelegramHtml(field.icon)} <b>${escapeTelegramHtml(field.label)}:</b> ${escapeTelegramHtml(field.value)}`
        ),
        `📍 <b>Этап кандидата:</b> ${escapeTelegramHtml(options.stage)}`,
    ];
    blocks.push(info.join("\n"));

    if (options.quote) {
        blocks.push(
            `<b>${escapeTelegramHtml(options.quoteLabel || "Сообщение кандидата")}</b>\n` +
            `<blockquote>${escapeTelegramHtml(options.quote)}</blockquote>`
        );
    }
    if (options.details?.length) {
        blocks.push(options.details.map((line) => escapeTelegramHtml(line)).join("\n"));
    }
    if (options.action) {
        blocks.push(`👉 <b>Что нужно сделать:</b> ${escapeTelegramHtml(options.action)}`);
    }
    return blocks.join("\n\n");
}

export const candidateTelegramOptions = {
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
};
