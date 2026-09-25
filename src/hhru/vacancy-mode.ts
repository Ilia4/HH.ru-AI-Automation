/**
 * Режим вакансии: «боевой» или «тест».
 *
 * Раньше право отправлять сообщения кандидатам выдавалось только списком
 * LIVE_VACANCY_IDS в .env — новую вакансию нельзя было включить без правки
 * сервера. Теперь режим хранится в самом реестре вакансий (колонка «Режим»)
 * и переключается из панели.
 *
 * Как это соединяется с ботом: реестр читают все ветки, и при каждом чтении
 * сюда кладётся свежий снимок режимов. Проверка режима остаётся синхронной,
 * поэтому вызывающему коду ничего менять не нужно.
 *
 * Осторожность по умолчанию: пока режим не прочитан или не указан, вакансия
 * считается тестовой — молчание безопаснее случайной рассылки.
 */

export type VacancyMode = "live" | "test";

const modes = new Map<string, VacancyMode>();

/** «боевой», «активная», «live», «да» → live; всё остальное (и пустое) → test. */
export function parseVacancyMode(raw: unknown): VacancyMode {
    const text = String(raw ?? "").toLowerCase().replace(/ё/g, "е").trim();
    if (!text) return "test";
    const live = ["боевой", "боевая", "бой", "актив", "активна", "активная", "вкл", "включена", "да", "live", "on", "yes", "1"];
    return live.some((word) => text === word || text.startsWith(word)) ? "live" : "test";
}

/** Снимок режимов из реестра. Вызывается при каждом чтении списка вакансий. */
export function setVacancyModes(entries: { vacancyId: string; mode: VacancyMode }[]): void {
    modes.clear();
    for (const e of entries) {
        if (e.vacancyId) modes.set(String(e.vacancyId), e.mode);
    }
}

/** Стоит ли вакансия в боевом режиме по данным реестра. */
export function isVacancyLiveByRegistry(vacancyId: string): boolean {
    return modes.get(String(vacancyId || "")) === "live";
}

/** Для диагностики: что бот сейчас думает о режимах. */
export function listVacancyModes(): Record<string, VacancyMode> {
    return Object.fromEntries(modes);
}
