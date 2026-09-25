/**
 * Конструктор анкет для HR-панели.
 *
 * Анкета создаётся в панели (вопросы + настройки) и получает публичную ссылку
 * /hr/f/<publicId>. Кандидат открывает её без авторизации и отправляет ответы,
 * они падают в таблицу FormResponse.
 *
 * Задел под HH (пока НЕ используется ботом): к ссылке можно добавить ?t=<токен>,
 * он сохраняется в ответе вместе с negotiationId/resumeId — чтобы потом точно
 * знать, кто заполнял, без сопоставления по ФИО и телефону.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "../lib/prisma.js";

export type QuestionType = "short" | "long" | "number" | "one" | "many" | "scale";

export interface Question {
    id: string;
    type: QuestionType;
    title: string;
    hint?: string;
    required: boolean;
    options?: string[];   // для one / many
    min?: number;         // для scale
    max?: number;
}

export interface FormPayload {
    title: string;
    description?: string;
    vacancyId?: string;
    vacancyName?: string;
    questions: Question[];
    status?: "draft" | "published";
}

const TYPES: QuestionType[] = ["short", "long", "number", "one", "many", "scale"];

function newId(bytes = 9): string {
    return randomBytes(bytes).toString("base64url");
}

/** Приводит вопросы к валидному виду, отбрасывая мусор. Бросает при явных ошибках. */
function normalizeQuestions(raw: any): Question[] {
    if (!Array.isArray(raw)) throw new Error("questions должен быть массивом");
    const out: Question[] = [];
    raw.forEach((q: any, i: number) => {
        const title = String(q?.title || "").trim();
        if (!title) return; // пустые строки просто пропускаем — так удобнее в конструкторе
        const type: QuestionType = TYPES.includes(q?.type) ? q.type : "short";
        const item: Question = {
            id: String(q?.id || "").trim() || `q${i + 1}_${newId(3)}`,
            type,
            title,
            required: Boolean(q?.required),
        };
        const hint = String(q?.hint || "").trim();
        if (hint) item.hint = hint;
        if (type === "one" || type === "many") {
            const options = (Array.isArray(q?.options) ? q.options : [])
                .map((o: any) => String(o || "").trim())
                .filter(Boolean);
            if (options.length < 2) throw new Error(`вопрос «${title}»: нужно минимум 2 варианта ответа`);
            item.options = options;
        }
        if (type === "scale") {
            const min = Number.isFinite(Number(q?.min)) ? Number(q.min) : 1;
            const max = Number.isFinite(Number(q?.max)) ? Number(q.max) : 10;
            if (max <= min) throw new Error(`вопрос «${title}»: максимум шкалы должен быть больше минимума`);
            item.min = min;
            item.max = max;
        }
        out.push(item);
    });
    return out;
}

export async function listForms() {
    const forms = await prisma.form.findMany({
        orderBy: { updatedAt: "desc" },
        include: { _count: { select: { responses: true } } },
    });
    return forms.map((f: any) => ({
        id: f.id,
        publicId: f.publicId,
        title: f.title,
        description: f.description,
        vacancyId: f.vacancyId,
        vacancyName: f.vacancyName,
        status: f.status,
        questionsCount: Array.isArray(f.questions) ? f.questions.length : 0,
        responsesCount: f._count?.responses ?? 0,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
    }));
}

export async function getForm(id: string) {
    const f = await prisma.form.findUnique({ where: { id } });
    if (!f) throw new Error("анкета не найдена");
    return f;
}

export async function createForm(payload: FormPayload, createdBy?: string) {
    const title = String(payload?.title || "").trim();
    if (!title) throw new Error("укажите название анкеты");
    const questions = normalizeQuestions(payload?.questions);
    if (questions.length === 0) throw new Error("добавьте хотя бы один вопрос");

    return prisma.form.create({
        data: {
            id: newId(12),
            publicId: newId(9),
            title,
            description: String(payload?.description || "").trim() || null,
            vacancyId: String(payload?.vacancyId || "").trim() || null,
            vacancyName: String(payload?.vacancyName || "").trim() || null,
            questions: questions as any,
            status: payload?.status === "published" ? "published" : "draft",
            createdBy: createdBy || null,
        },
    });
}

export async function updateForm(id: string, payload: FormPayload) {
    const title = String(payload?.title || "").trim();
    if (!title) throw new Error("укажите название анкеты");
    const questions = normalizeQuestions(payload?.questions);
    if (questions.length === 0) throw new Error("добавьте хотя бы один вопрос");

    return prisma.form.update({
        where: { id },
        data: {
            title,
            description: String(payload?.description || "").trim() || null,
            vacancyId: String(payload?.vacancyId || "").trim() || null,
            vacancyName: String(payload?.vacancyName || "").trim() || null,
            questions: questions as any,
            status: payload?.status === "published" ? "published" : "draft",
            updatedAt: new Date(),
        },
    });
}

export async function setFormStatus(id: string, status: "draft" | "published") {
    return prisma.form.update({ where: { id }, data: { status, updatedAt: new Date() } });
}

export async function deleteForm(id: string) {
    const count = await prisma.formResponse.count({ where: { formId: id } });
    if (count > 0) throw new Error(`нельзя удалить: есть ${count} ответ(ов). Снимите с публикации.`);
    await prisma.form.delete({ where: { id } });
    return { ok: true };
}

/** Публичный вид анкеты — только то, что нужно кандидату. */
export async function getPublicForm(publicId: string) {
    const f = await prisma.form.findUnique({ where: { publicId } });
    if (!f) return null;
    if (f.status !== "published") return null;
    return {
        publicId: f.publicId,
        title: f.title,
        description: f.description,
        vacancyName: f.vacancyName,
        questions: f.questions,
    };
}

/* ===================== ПЕРСОНАЛЬНЫЕ ПРИГЛАШЕНИЯ =====================
 * Ссылка вида /anketa/<publicId>?t=<token>. По токену анкета сама узнаёт,
 * кто её открыл: подставляет ФИО и телефон из резюме на HH, а ответ жёстко
 * привязывается к отклику — без сопоставления по ФИО и телефону, которое
 * раньше промахивалось.
 */
export interface InvitePayload {
    negotiationId?: string;
    resumeId?: string;
    vacancyId?: string;
    vacancyName?: string;
    hhAccountId?: string;
    candidateName?: string;
    candidatePhone?: string;
    /** срок жизни ссылки в днях; 0 или пусто — бессрочно */
    expiresInDays?: number;
}

/** Создаёт (или возвращает уже созданное) приглашение для кандидата. */
export async function createInvite(formId: string, payload: InvitePayload) {
    const form = await prisma.form.findUnique({ where: { id: formId } });
    if (!form) throw new Error("анкета не найдена");

    const negotiationId = String(payload.negotiationId || "").trim() || null;
    // Повторная отправка приглашения тому же кандидату не плодит ссылки.
    if (negotiationId) {
        const existing = await prisma.formInvite.findFirst({ where: { formId, negotiationId } });
        if (existing) return existing;
    }

    const days = Number(payload.expiresInDays);
    const expiresAt = Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 86400_000)
        : null;

    return prisma.formInvite.create({
        data: {
            token: newId(16),
            formId,
            negotiationId,
            resumeId: String(payload.resumeId || "").trim() || null,
            vacancyId: String(payload.vacancyId || "").trim() || null,
            vacancyName: String(payload.vacancyName || "").trim() || null,
            hhAccountId: String(payload.hhAccountId || "").trim() || null,
            candidateName: String(payload.candidateName || "").trim() || null,
            candidatePhone: String(payload.candidatePhone || "").trim() || null,
            expiresAt,
        },
    });
}

/** Данные для предзаполнения анкеты. Отдаём только то, что нужно кандидату. */
export async function getInvite(token: string) {
    const inv = await prisma.formInvite.findUnique({ where: { token } });
    if (!inv) return { status: "unknown" as const };
    if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) return { status: "expired" as const };
    if (inv.usedAt) return { status: "used" as const, candidateName: inv.candidateName };
    return {
        status: "ok" as const,
        candidateName: inv.candidateName,
        candidatePhone: inv.candidatePhone,
        vacancyName: inv.vacancyName,
        formId: inv.formId,
    };
}

export async function listInvites(formId: string) {
    const rows = await prisma.formInvite.findMany({
        where: { formId },
        orderBy: { createdAt: "desc" },
        take: 500,
    });
    return rows.map((i: any) => ({
        token: i.token,
        candidateName: i.candidateName,
        candidatePhone: i.candidatePhone,
        negotiationId: i.negotiationId,
        vacancyName: i.vacancyName,
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
        usedAt: i.usedAt,
    }));
}

export interface SubmitPayload {
    answers: { id: string; value: any }[];
    candidateName?: string;
    candidatePhone?: string;
    consent?: boolean;
    token?: string;
}

export async function submitResponse(publicId: string, payload: SubmitPayload, ip?: string) {
    const form = await prisma.form.findUnique({ where: { publicId } });
    if (!form || form.status !== "published") throw new Error("анкета недоступна");
    if (!payload?.consent) throw new Error("нужно согласие на обработку персональных данных");

    // Личность кандидата берём ИЗ БАЗЫ по токену, а не из того, что прислал браузер:
    // иначе привязку к отклику на HH можно было бы подделать.
    const token = String(payload.token || "").trim();
    let invite: any = null;
    if (token) {
        invite = await prisma.formInvite.findUnique({ where: { token } });
        if (invite) {
            if (invite.formId !== form.id) throw new Error("ссылка не подходит к этой анкете");
            if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) throw new Error("срок действия ссылки истёк");
            if (invite.usedAt) throw new Error("по этой ссылке анкета уже заполнена");
        }
    }

    const questions: Question[] = Array.isArray(form.questions) ? (form.questions as any) : [];
    const byId = new Map(questions.map((q) => [q.id, q]));
    const incoming = new Map((payload.answers || []).map((a) => [String(a?.id), a?.value]));

    const answers = questions.map((q) => {
        let value = incoming.get(q.id);
        if (Array.isArray(value)) value = value.map((v) => String(v ?? "").trim()).filter(Boolean);
        else value = String(value ?? "").trim();
        const empty = Array.isArray(value) ? value.length === 0 : value === "";
        if (q.required && empty) throw new Error(`не заполнен обязательный вопрос: «${q.title}»`);
        return { id: q.id, title: q.title, type: q.type, value };
    });
    // вопросы, которых нет в анкете, игнорируем молча
    for (const id of incoming.keys()) if (!byId.has(id)) continue;

    const saved = await prisma.formResponse.create({
        data: {
            id: newId(12),
            formId: form.id,
            candidateToken: token || null,
            // из приглашения — надёжная привязка к HH; из формы — то, что ввёл человек
            negotiationId: invite?.negotiationId || null,
            resumeId: invite?.resumeId || null,
            candidateName: invite?.candidateName || String(payload.candidateName || "").trim() || null,
            candidatePhone: String(payload.candidatePhone || "").trim() || invite?.candidatePhone || null,
            answers: answers as any,
            consent: true,
            ip: ip || null,
        },
    });

    if (invite) {
        await prisma.formInvite.update({
            where: { token: invite.token },
            data: { usedAt: new Date(), responseId: saved.id },
        });
    }
    return saved;
}

export async function listResponses(formId: string) {
    const rows = await prisma.formResponse.findMany({
        where: { formId },
        orderBy: { submittedAt: "desc" },
        take: 500,
    });
    return rows.map((r: any) => ({
        id: r.id,
        candidateName: r.candidateName,
        candidatePhone: r.candidatePhone,
        candidateToken: r.candidateToken,
        negotiationId: r.negotiationId,
        resumeId: r.resumeId,
        // ссылка на резюме собирается ровно как в остальных модулях бота
        resumeUrl: r.resumeId && r.negotiationId ? `https://hh.ru/resume/${r.resumeId}?t=${r.negotiationId}` : null,
        answers: r.answers,
        submittedAt: r.submittedAt,
    }));
}
