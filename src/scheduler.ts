// Планировщик задач по времени.
// Чтобы добавить новую задачу — добавь объект в массив JOBS.

interface Job {
    name: string;
    hours: number[];   // в какие часы запускать (0-23)
    minutes: number;   // в какую минуту часа (0-59)
    run: () => Promise<void>;
}

// Храним время последнего запуска каждой задачи
const lastRun = new Map<string, string>();

// Часовой пояс планировщика (по умолчанию Москва) — чтобы не зависеть от таймзоны сервера (UTC)
const TZ = process.env.SCHEDULER_TZ || "Europe/Moscow";

function currentTimeKey(hour: number, minute: number): string {
    return `${hour}:${String(minute).padStart(2, "0")}`;
}

/** Часы/минуты/дата в заданной таймзоне */
function tzParts(date: Date): { hour: number; minute: number; day: string } {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    return { hour, minute, day };
}

export function createScheduler(jobs: Job[]) {
    return function tick() {
        const now = new Date();
        const { hour, minute, day } = tzParts(now);

        for (const job of jobs) {
            if (!job.hours.includes(hour)) continue;
            if (minute !== job.minutes) continue;

            const key = `${job.name}__${currentTimeKey(hour, minute)}__${day}`;
            if (lastRun.get(job.name) === key) continue;

            lastRun.set(job.name, key);
            console.log(`[scheduler] запуск задачи "${job.name}" в ${currentTimeKey(hour, minute)} (${TZ})`);

            job.run().catch((err) => {
                console.error(`[scheduler] ошибка в задаче "${job.name}":`, err);
            });
        }
    };
}
