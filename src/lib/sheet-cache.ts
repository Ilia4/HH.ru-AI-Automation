/**
 * Небольшой кэш для чтения Google-таблиц.
 *
 * Зачем: справочники (реестр вакансий, шаблоны писем, фильтры, база вопросов)
 * перечитывались при каждом обращении — по разу на вакансию, каждые пять минут.
 * Из-за этого бот регулярно упирался в лимит Google «Read requests per minute»,
 * и часть циклов пропускалась.
 *
 * Что кэшируем: ТОЛЬКО справочники, которые HR правит редко.
 * Что НЕ кэшируем: листы «ИИ анализ резюме» и «ИИ анализ тестового задания»
 * (там решения HR — нужны свежими) и календарь собеседований (иначе можно
 * записать двоих на один слот).
 *
 * Выключить целиком: SHEETS_CACHE_TTL=0
 */

interface Entry {
    value: unknown;
    expiresAt: number;
}

const store = new Map<string, Entry>();
let hits = 0;
let misses = 0;

/** Время жизни записи, сек. По умолчанию 3 минуты — цикл бота идёт раз в 5 минут. */
function ttlSeconds(): number {
    const raw = process.env.SHEETS_CACHE_TTL;
    if (raw === undefined || raw === "") return 180;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 180;
}

/**
 * Отдаёт значение из кэша или считает его заново.
 * При ошибке загрузки ничего не кэшируем — пусть следующий вызов попробует снова.
 */
export async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const ttl = ttlSeconds();
    if (ttl === 0) return load();

    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expiresAt > now) {
        hits++;
        return hit.value as T;
    }

    misses++;
    const value = await load();
    store.set(key, { value, expiresAt: now + ttl * 1000 });
    return value;
}

/** Сброс после записи в лист — чтобы бот сразу увидел то, что сам записал. */
export function invalidate(key: string): void {
    store.delete(key);
}

/** Сброс всех записей, ключ которых начинается с префикса (например, по одной таблице). */
export function invalidatePrefix(prefix: string): void {
    for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
    }
}

export function cacheStats(): { hits: number; misses: number; size: number; ttl: number } {
    return { hits, misses, size: store.size, ttl: ttlSeconds() };
}

/** Раз в час пишем в лог, сколько чтений сэкономили — чтобы видеть эффект. */
export function startCacheStatsLog(): void {
    setInterval(() => {
        const s = cacheStats();
        if (s.hits + s.misses === 0) return;
        const saved = Math.round((s.hits / (s.hits + s.misses)) * 100);
        console.log(`[sheets-cache] за час: из кэша ${s.hits}, из Google ${s.misses} (${saved}% запросов сэкономлено), записей ${s.size}`);
        hits = 0;
        misses = 0;
    }, 3600_000);
}
