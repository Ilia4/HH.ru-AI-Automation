import "dotenv/config";
import express from "express";
import path from "node:path";
import { getAllCandidates, getCandidateDetail, applyDecision } from "./data";
import { getErrors } from "./errors";
import { getDiagnostics } from "./diagnostics";
import { listRegistry, setVacancyActive, setVacancyMode, createVacancy, listAccounts } from "./registry";
import { authGuard, sessionHandler, loginHandler, logoutHandler } from "./auth";
import {
    listForms, getForm, createForm, updateForm, setFormStatus, deleteForm,
    getPublicForm, submitResponse, listResponses,
    createInvite, getInvite, listInvites,
} from "./forms";
import { checkSpreadsheet, defaultTemplates, buildVacancy } from "./wizard";
import { getAnketaDetail } from "./anketa-detail";
import { getSchedule, groupByDay } from "../hhru/schedule-view";
import { getTasks } from "./tasks";

const PANEL_DIR = path.resolve(process.cwd(), "src", "panel");
const app = express();
const PORT = Number(process.env.PANEL_PORT) || 4000;
const BASE = process.env.PANEL_BASE || "/hr";
const ANKETA_BASE = process.env.ANKETA_BASE || "/anketa";

const router = express.Router();
router.use(express.json());

router.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "hr-panel", ts: new Date().toISOString() });
});
router.get("/api/session", sessionHandler);
router.post("/api/login", loginHandler);
router.post("/api/logout", logoutHandler);

// Старые ссылки вида /hr/f/<id> уводим на публичный путь — чтобы не светить панель.
router.get("/f/:publicId", (req, res) => {
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    res.redirect(302, `${ANKETA_BASE}/${encodeURIComponent(req.params.publicId)}${qs}`);
});

router.use("/api", authGuard);

// --- КОНСТРУКТОР АНКЕТ (под авторизацией) ---
router.get("/api/forms", async (_req, res) => {
    try {
        res.json({ ok: true, forms: await listForms() });
    } catch (e: any) {
        console.error("[panel] /api/forms:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/forms/:id", async (req, res) => {
    try {
        res.json({ ok: true, form: await getForm(String(req.params.id)) });
    } catch (e: any) {
        res.status(404).json({ ok: false, error: String(e?.message || e) });
    }
});

router.post("/api/forms", async (req, res) => {
    try {
        const form = await createForm(req.body || {});
        console.log(`[panel] анкета создана «${form.title}» → ${form.publicId}`);
        res.json({ ok: true, form });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

router.put("/api/forms/:id", async (req, res) => {
    try {
        const form = await updateForm(String(req.params.id), req.body || {});
        res.json({ ok: true, form });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

router.post("/api/forms/:id/status", async (req, res) => {
    try {
        const status = req.body?.status === "published" ? "published" : "draft";
        const form = await setFormStatus(String(req.params.id), status);
        console.log(`[panel] анкета ${form.publicId} → ${status}`);
        res.json({ ok: true, form });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

router.delete("/api/forms/:id", async (req, res) => {
    try {
        res.json(await deleteForm(String(req.params.id)));
    } catch (e: any) {
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/anketa-detail", async (req, res) => {
    try {
        const spreadsheetId = String(req.query.spreadsheetId || "");
        const row = Number(req.query.row || 0);
        const fio = String(req.query.fio || "");
        if (!spreadsheetId || !row) return res.status(400).json({ ok: false, error: "нужны spreadsheetId и row" });
        res.json(await getAnketaDetail(spreadsheetId, row, fio));
    } catch (e: any) {
        console.error("[panel] /api/anketa-detail:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

// --- МАСТЕР СОЗДАНИЯ ВАКАНСИИ ---
router.post("/api/wizard/check-sheet", async (req, res) => {
    try {
        res.json(await checkSpreadsheet(String(req.body?.url || "")));
    } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/wizard/defaults", (req, res) => {
    res.json({ ok: true, templates: defaultTemplates(String(req.query.company || "компания")) });
});

router.post("/api/wizard/build", async (req, res) => {
    try {
        const result = await buildVacancy(req.body || {});
        console.log(`[wizard] вакансия «${req.body?.name}» создана → ${result.vacancyId}`);
        res.json(result);
    } catch (e: any) {
        console.error("[wizard]", e?.message || e);
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

router.post("/api/forms/:id/invites", async (req, res) => {
    try {
        const invite = await createInvite(String(req.params.id), req.body || {});
        console.log(`[panel] приглашение ${invite.token} → ${invite.candidateName || "без имени"}`);
        res.json({ ok: true, invite });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/forms/:id/invites", async (req, res) => {
    try {
        res.json({ ok: true, invites: await listInvites(String(req.params.id)) });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/forms/:id/responses", async (req, res) => {
    try {
        res.json({ ok: true, responses: await listResponses(String(req.params.id)) });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/candidates", async (req, res) => {
    try {
        const force = req.query.refresh === "1" || req.query.refresh === "true";
        const data = await getAllCandidates(force);
        res.json({ ok: true, count: data.length, candidates: data });
    } catch (e: any) {
        console.error("[panel] /api/candidates:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/candidate/:vacancyId/:resumeId", async (req, res) => {
    try {
        const detail = await getCandidateDetail(req.params.vacancyId, req.params.resumeId);
        res.json({ ok: true, detail });
    } catch (e: any) {
        console.error("[panel] /api/candidate:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.post("/api/decision", async (req, res) => {
    try {
        const { vacancyId, kind, value, resumeId, row, fio } = req.body || {};
        if (kind !== "resume" && kind !== "anketa") {
            return res.status(400).json({ ok: false, error: "kind должен быть resume или anketa" });
        }
        if (!vacancyId) return res.status(400).json({ ok: false, error: "нет vacancyId" });
        const result = await applyDecision(String(vacancyId), kind, String(value ?? ""), {
            resumeId: resumeId ? String(resumeId) : undefined,
            row: row ? Number(row) : undefined,
            fio: fio ? String(fio) : undefined,
        });
        console.log(
            `[panel] decision ${kind}=${value} vac=${vacancyId} row=${row} res=${resumeId || "-"} → ${
                result.ok ? result.cell : "ERR " + result.error
            }`,
        );
        res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) {
        console.error("[panel] /decision:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

// Главный экран: короткий список дел на сегодня.
router.get("/api/tasks", async (req, res) => {
    try {
        const force = req.query.refresh === "1" || req.query.refresh === "true";
        res.json({ ok: true, ...(await getTasks(force)) });
    } catch (e: any) {
        console.error("[panel] /api/tasks:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

// Расписание собеседований: тот же календарь, что ведёт бот. Только чтение.
router.get("/api/calendar", async (req, res) => {
    try {
        const vacancy = String(req.query.vacancy || "").trim() || undefined;
        const items = await getSchedule(vacancy);
        res.json({ ok: true, days: groupByDay(items), total: items.length });
    } catch (e: any) {
        console.error("[panel] /api/calendar:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/errors", (_req, res) => {
    try {
        res.json({ ok: true, ...getErrors() });
    } catch (e: any) {
        console.error("[panel] /api/errors:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/diagnostics", async (req, res) => {
    try {
        const force = req.query.refresh === "1" || req.query.refresh === "true";
        res.json({ ok: true, ...(await getDiagnostics(force)) });
    } catch (e: any) {
        console.error("[panel] /api/diagnostics:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.get("/api/vacancies", async (_req, res) => {
    try {
        const [reg, accounts] = await Promise.all([listRegistry(), listAccounts()]);
        res.json({ ok: true, tab: reg.tab, vacancies: reg.vacancies, accounts });
    } catch (e: any) {
        console.error("[panel] /api/vacancies:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.post("/api/vacancy/toggle", async (req, res) => {
    try {
        const { row, active } = req.body || {};
        const result = await setVacancyActive(Number(row), Boolean(active));
        console.log(
            `[panel] toggle row=${row} active=${active} → ${result.ok ? result.status : "ERR " + result.error}`,
        );
        res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) {
        console.error("[panel] /vacancy/toggle:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

// Режим вакансии: «боевой» (бот пишет кандидатам) или «тест» (только анализ).
router.post("/api/vacancy/mode", async (req, res) => {
    try {
        const { row, mode } = req.body || {};
        if (mode !== "live" && mode !== "test") {
            return res.status(400).json({ ok: false, error: "mode должен быть live или test" });
        }
        const result = await setVacancyMode(Number(row), mode);
        console.log(`[panel] mode row=${row} → ${result.ok ? mode : "ERR " + result.error}`);
        res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) {
        console.error("[panel] /vacancy/mode:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.post("/api/vacancy/create", async (req, res) => {
    try {
        const result = await createVacancy(req.body || {});
        console.log(
            `[panel] create «${req.body?.name}» → ${result.ok ? "id " + result.vacancyId : "ERR " + result.error}`,
        );
        res.status(result.ok ? 200 : 400).json(result);
    } catch (e: any) {
        console.error("[panel] /vacancy/create:", e?.message || e);
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

router.use(express.static(path.join(PANEL_DIR, "public")));
router.get("/*splat", (_req, res) => {
    res.sendFile(path.join(PANEL_DIR, "public", "index.html"));
});

/**
 * ПУБЛИЧНАЯ ЧАСТЬ — анкета для кандидата. Вынесена из /hr намеренно:
 * по ссылке не видно, что за ней стоит внутренняя панель, и обрезав адрес
 * до корня, кандидат попадает на нейтральную заглушку, а не на форму входа.
 * Авторизации здесь нет и быть не должно.
 */
const anketa = express.Router();
anketa.use(express.json());

anketa.get("/api/form/:publicId", async (req, res) => {
    try {
        const form = await getPublicForm(String(req.params.publicId));
        if (!form) return res.status(404).json({ ok: false, error: "Анкета не найдена или снята с публикации" });
        res.json({ ok: true, form });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

// Данные для предзаполнения: кто открыл анкету по персональной ссылке.
anketa.get("/api/invite/:token", async (req, res) => {
    try {
        res.json({ ok: true, ...(await getInvite(String(req.params.token))) });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

anketa.post("/api/form/:publicId/submit", async (req, res) => {
    try {
        const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
        const saved = await submitResponse(String(req.params.publicId), req.body || {}, ip);
        console.log(`[anketa] ${req.params.publicId}: ответ принят (${saved.id})`);
        res.json({ ok: true });
    } catch (e: any) {
        console.warn("[anketa] submit:", e?.message || e);
        res.status(400).json({ ok: false, error: String(e?.message || e) });
    }
});

// Корень публичной части — нейтральная заглушка без единого намёка на панель.
anketa.get("/", (_req, res) => {
    res.status(404).send(
        `<!doctype html><html lang="ru"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1"><title>Анкета</title>` +
        `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
        `font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f6fa;color:#6b7488}` +
        `div{text-align:center;padding:24px}</style></head><body><div>` +
        `<p>Здесь открывается анкета по персональной ссылке.</p>` +
        `<p>Проверьте, что скопировали ссылку целиком.</p></div></body></html>`,
    );
});

anketa.get("/:publicId", (_req, res) => {
    res.sendFile(path.join(PANEL_DIR, "public", "form.html"));
});

app.use(ANKETA_BASE, anketa);
app.use(BASE, router);
app.get("/", (_req, res) => res.redirect(BASE + "/"));

app.listen(PORT, () => {
    console.log(`[panel] hr-panel слушает порт ${PORT}, базовый путь ${BASE}`);
});
