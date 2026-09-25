/**
 * Мгновенная защита от продолжения уже запущенного прохода после паузы вакансии.
 *
 * Реестр Google определяет, попадёт ли вакансия в следующий запуск. Но длинный
 * проход уже держит полученный список в памяти. Ревизия ниже делает такой проход
 * недействительным сразу после нажатия «Приостановить».
 */
export interface VacancyRunToken {
    vacancyId: string;
    revision: number;
}

interface RuntimeActivity {
    active: boolean;
    revision: number;
}

const runtimeActivity = new Map<string, RuntimeActivity>();

function idOf(vacancyId: string): string {
    return String(vacancyId || "").trim();
}

/** Вызывается после изменения статуса вакансии в реестре. */
export function setRuntimeVacancyActive(vacancyId: string, active: boolean): void {
    const id = idOf(vacancyId);
    if (!id) return;
    const previous = runtimeActivity.get(id);
    runtimeActivity.set(id, {
        active,
        revision: (previous?.revision ?? 0) + 1,
    });
}

/** Быстрая проверка для вакансий, которые ещё не начали работу в текущем цикле. */
export function isRuntimeVacancyStopped(vacancyId: string): boolean {
    const id = idOf(vacancyId);
    return Boolean(id && runtimeActivity.get(id)?.active === false);
}

/** Снимок поколения конкретного прохода. */
export function beginVacancyRun(vacancyId: string): VacancyRunToken {
    const id = idOf(vacancyId);
    return { vacancyId: id, revision: runtimeActivity.get(id)?.revision ?? 0 };
}

/**
 * false означает: вакансию остановили или успели остановить и включить снова.
 * Старый проход в обоих случаях продолжаться не должен.
 */
export function canContinueVacancyRun(token: VacancyRunToken): boolean {
    if (!token.vacancyId) return true;
    const current = runtimeActivity.get(token.vacancyId);
    if (!current) return token.revision === 0;
    return current.active && current.revision === token.revision;
}
