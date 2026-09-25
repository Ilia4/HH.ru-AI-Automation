import type { Bot, Context } from "grammy";
import { prisma } from "../lib/prisma";
import { askAi, parseAiJsonText } from "../hhru/ai-scorer";
import { listTopics } from "../hhru/topics.store";
import { listTrackedVacancies } from "../chat-sim/vacancies";

// ── Часовой пояс: считаем «сегодня/вчера» по Москве (UTC+3) ────────────────────
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function startOfTodayMskUtc(): Date {
    const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
    const y = nowMsk.getUTCFullYear(), m = nowMsk.getUTCMonth(), d = nowMsk.getUTCDate();
    return new Date(Date.UTC(y, m, d) - MSK_OFFSET_MS);
}

function sinceForPeriod(period: string | null): { since: Date; label: string } | null {
    if (!period) return null;
    const now = Date.now();
    if (period === "today") return { since: startOfTodayMskUtc(), label: "сегодня" };
    if (period === "yesterday") {
        const t = startOfTodayMskUtc();
        return { since: new Date(t.getTime() - 24 * 3600 * 1000), label: "вчера" };
    }
    if (period === "7d") return { since: new Date(now - 7 * 24 * 3600 * 1000), label: "за 7 дней" };
    if (period === "30d") return { since: new Date(now - 30 * 24 * 3600 * 1000), label: "за 30 дней" };
    return null;
}

function plural(n: number, one: string, few: string, many: string): string {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
    return `${n} ${many}`;
}
const cand = (n: number) => plural(n, "кандидат", "кандидата", "кандидатов");

// ── Тема Telegram → вакансия ───────────────────────────────────────────────────
interface VacRef { vacancyId: string; vacancyName: string; }

async function vacancyByThread(threadId: number | undefined): Promise<VacRef | null> {
    if (threadId === undefined || threadId === null) return null;
    const topics = listTopics(); // name -> threadId
    let vacs: Awaited<ReturnType<typeof listTrackedVacancies>> = [];
    try { vacs = await listTrackedVacancies(); } catch { vacs = []; }
    const norm = (x: string) => String(x || "").toLowerCase().trim();
    for (const v of vacs) {
        let tid = topics[v.vacancyName];
        if (tid === undefined) {
            const key = Object.keys(topics).find((k) => norm(k) === norm(v.vacancyName));
            if (key) tid = topics[key];
        }
        if (tid === threadId) return { vacancyId: v.vacancyId, vacancyName: v.vacancyName };
    }
    return null;
}

// ── Данные из локальной базы (ИИ к HH не ходит) ────────────────────────────────
async function currentRows(vacancyId: string) {
    return prisma.vacancyStageCurrent.findMany({ where: { vacancyId }, orderBy: { count: "desc" } });
}

async function resolveStage(vacancyId: string, stageRaw: string | null): Promise<{ id: string; name: string } | null> {
    if (!stageRaw) return null;
    const rows = await currentRows(vacancyId);
    const norm = (x: string) => String(x || "").toLowerCase().trim();
    const s = norm(stageRaw);
    // точное по id или по названию
    let hit = rows.find((r) => norm(r.stage) === s || norm(r.stageName) === s);
    if (hit) return { id: hit.stage, name: hit.stageName };
    // частичное по названию
    hit = rows.find((r) => norm(r.stageName).includes(s) || s.includes(norm(r.stageName)));
    if (hit) return { id: hit.stage, name: hit.stageName };
    return null;
}

async function snapshotCountAt(vacancyId: string, stage: string, target: Date): Promise<number | null> {
    const row = await prisma.vacancyStageSnapshot.findFirst({
        where: { vacancyId, stage, capturedAt: { lte: target } },
        orderBy: { capturedAt: "desc" },
    });
    return row ? row.count : null;
}

// ── ИИ: вопрос → структура ────────────────────────────────────────────────────
interface Intent {
    kind: "count" | "breakdown" | "total" | "new" | "moved" | "list" | "compare" | "help" | "unknown";
    stage: string | null;
    period: "today" | "yesterday" | "7d" | "30d" | null;
}

async function parseIntent(question: string, stages: { id: string; name: string }[]): Promise<Intent> {
    const stageList = stages.map((s) => `- ${s.id} = «${s.name}»`).join("\n");
    const prompt = [
        "Ты — аналитический ассистент HR по одной конкретной вакансии.",
        "Разбери вопрос менеджера и верни ТОЛЬКО JSON:",
        '{"kind":"count|breakdown|total|new|moved|list|compare|help|unknown","stage":"<id стадии или null>","period":"today|yesterday|7d|30d|null"}',
        "",
        "kind:",
        "- count — сколько кандидатов сейчас в конкретной стадии (нужен stage).",
        "- breakdown — разбивка по всем стадиям (сколько где).",
        "- total — сколько всего кандидатов по вакансии.",
        "- new — сколько новых кандидатов появилось за период (можно с stage).",
        "- moved — сколько перешло в конкретную стадию за период (нужен stage + period).",
        "- list — перечислить кандидатов в конкретной стадии по именам (нужен stage).",
        "- compare — сравнить текущее число в стадии с прошлым периодом (нужен stage + period).",
        "- help — просят перечислить, что ты умеешь.",
        "- unknown — не про аналитику вакансии / непонятно.",
        "",
        "Стадии этой вакансии (используй id в поле stage):",
        stageList,
        "",
        "period: today=сегодня, yesterday=вчера, 7d=неделя, 30d=месяц, null=если период не указан.",
        "Если стадия не названа — stage=null.",
        "",
        "Синонимы стадий (сопоставляй по смыслу):",
        "- «подумать», «на подумать», «думаем» → consider",
        "- «первичный контакт», «первичка», «в контакте» → phone_interview",
        "- «отклик», «отклики», «новые», «неразобранные» → response",
        "- «тестовое», «тестовое задание», «на тесте» → assessment",
        "- «собеседование», «интервью», «на собесе» → interview",
        "- «оффер», «предложение о работе» → offer",
        "- «вышел на работу», «нанят», «принят» → hired",
        "- «отказ», «отказали», «мы отказали», «не подходит», «отклонили» → discard_by_employer",
        "- «кандидат отказался», «сам отказался», «отказался кандидат» → discard_by_applicant",
        "- «не выходит на связь», «не отвечает» → discard_no_interaction",
        "Если тип отказа не уточнён — по умолчанию discard_by_employer (мы отказали).",
        "",
        `Вопрос: ${question}`,
    ].join("\n");
    try {
        const r = parseAiJsonText(await askAi(prompt));
        const kind = ["count", "breakdown", "total", "new", "moved", "list", "compare", "help", "unknown"].includes(r?.kind)
            ? r.kind : "unknown";
        const period = ["today", "yesterday", "7d", "30d"].includes(r?.period) ? r.period : null;
        return { kind, stage: r?.stage ? String(r.stage) : null, period };
    } catch {
        return { kind: "unknown", stage: null, period: null };
    }
}

// ── Формирование ответа ────────────────────────────────────────────────────────
async function answerIntent(vac: VacRef, intent: Intent): Promise<string> {
    const rows = await currentRows(vac.vacancyId);
    if (!rows.length) return `По «${vac.vacancyName}» пока нет данных — статистика ещё не собралась, попробуйте через пару минут.`;

    const stage = await resolveStage(vac.vacancyId, intent.stage);

    switch (intent.kind) {
        case "count": {
            if (!stage) return "Уточните стадию — по какой именно нужно число? Например: «сколько на собеседовании».";
            const row = rows.find((r) => r.stage === stage.id);
            const n = row?.count ?? 0;
            return `«${stage.name}» — сейчас ${cand(n)} (${vac.vacancyName}).`;
        }
        case "breakdown": {
            const lines = rows.filter((r) => r.count > 0).map((r) => `• ${r.stageName}: ${r.count}`);
            const total = rows.reduce((a, r) => a + r.count, 0);
            return [`📊 «${vac.vacancyName}» — по стадиям:`, ...(lines.length ? lines : ["(пусто)"]), ``, `Всего: ${cand(total)}.`].join("\n");
        }
        case "total": {
            const total = rows.reduce((a, r) => a + r.count, 0);
            return `Всего по «${vac.vacancyName}» — ${cand(total)} (во всех стадиях).`;
        }
        case "new": {
            const p = sinceForPeriod(intent.period) ?? { since: startOfTodayMskUtc(), label: "сегодня" };
            const where: any = { vacancyId: vac.vacancyId, firstSeenAt: { gte: p.since } };
            if (stage) where.stage = stage.id;
            const n = await prisma.candidateStageState.count({ where });
            const scope = stage ? ` в стадии «${stage.name}»` : "";
            return `Новых кандидатов${scope} ${p.label}: ${cand(n)} (${vac.vacancyName}).`;
        }
        case "moved": {
            if (!stage) return "Уточните стадию — куда перешли? Например: «сколько перешло на собеседование за неделю».";
            const p = sinceForPeriod(intent.period) ?? { since: startOfTodayMskUtc(), label: "сегодня" };
            const n = await prisma.candidateStageState.count({
                where: { vacancyId: vac.vacancyId, stage: stage.id, stageChangedAt: { gte: p.since } },
            });
            return `Перешло в «${stage.name}» ${p.label}: ${cand(n)} (${vac.vacancyName}).`;
        }
        case "list": {
            if (!stage) return "Уточните стадию — кого перечислить? Например: «кто на собеседовании».";
            const items = await prisma.candidateStageState.findMany({
                where: { vacancyId: vac.vacancyId, stage: stage.id },
                orderBy: { stageChangedAt: "desc" },
                take: 50,
            });
            if (!items.length) return `В стадии «${stage.name}» сейчас никого (${vac.vacancyName}).`;
            const names = items.map((i, idx) => `${idx + 1}. ${i.candidateName}`).join("\n");
            return `«${stage.name}» (${vac.vacancyName}) — ${cand(items.length)}:\n${names}`;
        }
        case "compare": {
            if (!stage) return "Уточните стадию для сравнения. Например: «на собеседовании стало больше, чем неделю назад?».";
            const p = sinceForPeriod(intent.period) ?? { since: new Date(Date.now() - 7 * 24 * 3600 * 1000), label: "неделю назад" };
            const nowN = rows.find((r) => r.stage === stage.id)?.count ?? 0;
            const past = await snapshotCountAt(vac.vacancyId, stage.id, p.since);
            if (past === null) return `«${stage.name}» — сейчас ${cand(nowN)}. Данных за «${p.label}» пока нет (история ещё копится).`;
            const diff = nowN - past;
            const sign = diff > 0 ? `+${diff}` : String(diff);
            const word = diff > 0 ? "больше" : diff < 0 ? "меньше" : "столько же";
            return `«${stage.name}» (${vac.vacancyName}): сейчас ${nowN}, ${p.label} было ${past} → ${sign} (${word}).`;
        }
        case "help": {
            return [
                `Я отвечаю по вакансии этой темы («${vac.vacancyName}»). Примеры:`,
                "• «сколько на собеседовании» / «сколько в стадии подумать»",
                "• «разбивка по стадиям» / «сколько всего кандидатов»",
                "• «сколько новых откликов сегодня» / «сколько новых за неделю»",
                "• «сколько перешло на собеседование за неделю»",
                "• «кто на собеседовании» (список имён)",
                "• «на собеседовании стало больше, чем неделю назад?»",
            ].join("\n");
        }
        default:
            return [
                "Не понял вопрос по аналитике. Могу, например:",
                "«сколько на собеседовании», «разбивка по стадиям», «сколько новых сегодня», «кто в стадии подумать».",
            ].join("\n");
    }
}

// ── Служебный вызов для тестов/диагностики ─────────────────────────────────────
export async function debugAnalytics(vacancyId: string, vacancyName: string, question: string): Promise<string> {
    const rows = await currentRows(vacancyId);
    const stages = rows.map((r) => ({ id: r.stage, name: r.stageName }));
    const intent = await parseIntent(question, stages);
    const ans = await answerIntent({ vacancyId, vacancyName }, intent);
    return `Q: ${question}\n  intent=${JSON.stringify(intent)}\n  → ${ans.replace(/\n/g, "\n    ")}`;
}

// ── Хендлер: тег бота в теме вакансии ──────────────────────────────────────────
export function registerAnalyticsAssistant(bot: Bot<Context>) {
    bot.on("message:text", async (ctx, next) => {
        const groupId = process.env.GROUP_CHAT_ID;
        if (!groupId || String(ctx.chat.id) !== groupId) return next();

        const me = ctx.me?.username ? "@" + ctx.me.username : null;
        const text = String(ctx.message.text || "");
        if (!me || !text.toLowerCase().includes(me.toLowerCase())) return next();

        const question = text.replace(new RegExp(me, "ig"), "").trim();
        const vac = await vacancyByThread(ctx.message.message_thread_id);
        if (!vac) {
            await ctx.reply("Задайте вопрос в теме нужной вакансии — я отвечаю по той вакансии, к чьей теме относится сообщение.", {
                reply_parameters: { message_id: ctx.message.message_id },
            });
            return;
        }
        try {
            const rows = await currentRows(vac.vacancyId);
            const stages = rows.map((r) => ({ id: r.stage, name: r.stageName }));
            const intent = await parseIntent(question, stages);
            const reply = await answerIntent(vac, intent);
            await ctx.reply(reply, { reply_parameters: { message_id: ctx.message.message_id } });
        } catch (e: any) {
            console.error("[assistant] ошибка:", e);
            await ctx.reply("Не смог посчитать — что-то пошло не так. Попробуйте переформулировать.", {
                reply_parameters: { message_id: ctx.message.message_id },
            });
        }
    });
}
