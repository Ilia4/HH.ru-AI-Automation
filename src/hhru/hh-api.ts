import { getValidAccessToken } from "../hh-auth/hh-auth.service";

const API_BASE = "https://api.hh.ru";
const USER_AGENT = process.env.HH_USER_AGENT || "hr-tg-bot/1.0 (gf12658@gmail.com)";

async function authHeaders(
    extra: Record<string, string> = {},
    accountId?: string,
): Promise<Record<string, string>> {
    const token = await getValidAccessToken(accountId);
    if (!token) throw new Error("Нет токена HH.ru — нужна авторизация (/auth)");
    return {
        Authorization: `Bearer ${token}`,
        "HH-User-Agent": USER_AGENT,
        ...extra,
    };
}

/**
 * Проверка живости токена HH — лёгкий запрос /me.
 * network=true → сетевой сбой (НЕ проблема токена, не тревожим).
 * Не вызывает refresh принудительно: использует текущий токен как есть.
 */
export interface HhIdentity {
    hhUserId?: string;
    managerId?: string;
    employerId?: string;
    employerName?: string;
    email?: string;
}

export async function checkHhAuth(accountId: string): Promise<{ ok: boolean; reason: string; network?: boolean; identity?: HhIdentity }> {
    let headers: Record<string, string>;
    try {
        headers = await authHeaders({}, accountId);
    } catch {
        return { ok: false, reason: "нет токена — нужна авторизация (/auth)" };
    }
    try {
        const res = await fetch(`${API_BASE}/me`, { headers });
        if (res.ok) {
            let identity: HhIdentity = {};
            try {
                const me: any = await res.json();
                identity = {
                    hhUserId: me?.id != null ? String(me.id) : undefined,
                    managerId: me?.manager?.id != null ? String(me.manager.id) : undefined,
                    employerId: me?.employer?.id != null ? String(me.employer.id) : undefined,
                    employerName: me?.employer?.name || undefined,
                    email: me?.email || undefined,
                };
            } catch {}
            return { ok: true, reason: "", identity };
        }
        const t = await res.text();
        let detail = `HTTP ${res.status}`;
        try {
            const j: any = JSON.parse(t);
            detail = j?.errors?.[0]?.value || j?.oauth_error || j?.description || detail;
        } catch {}
        if (t.includes("token-revoked") || t.includes("token_revoked")) return { ok: false, reason: `токен отозван (${detail})` };
        if (res.status === 401 || res.status === 403) return { ok: false, reason: `нет авторизации: ${detail}` };
        return { ok: true, reason: "" }; // прочие ошибки HH — не про токен
    } catch {
        return { ok: true, reason: "", network: true }; // сетевой сбой — не тревожим
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET-запрос к HH API с авторизацией, таймаутом и ретраями.
 * Раньше был голый fetch без таймаута: если HH подвисал на запросе, процесс замирал
 * навсегда (нечем оборвать). Теперь запрос обрывается по таймауту (AbortController),
 * а транзиентные сбои (таймаут / сеть / 429 / 5xx) повторяются несколько раз с паузой.
 */
async function apiGet(url: string): Promise<any> {
    const TIMEOUT_MS = Number(process.env.HH_HTTP_TIMEOUT_MS) || 25000;
    const MAX_RETRIES = Number(process.env.HH_HTTP_RETRIES) || 2;
    let lastErr: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(url, { headers: await authHeaders(), signal: controller.signal });
        } catch (err: any) {
            clearTimeout(timer);
            lastErr = err;
            const isAbort = err?.name === "AbortError";
            const isNetwork = /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|und_err/i.test(String(err?.message || ""));
            if ((isAbort || isNetwork) && attempt < MAX_RETRIES) {
                await sleep(800 * (attempt + 1));
                continue;
            }
            throw new Error(isAbort ? `HH GET ${url} → таймаут ${TIMEOUT_MS}ms (попыток ${attempt + 1})` : String(err?.message || err));
        }
        clearTimeout(timer);
        if (res.ok) return res.json();
        const text = await res.text();
        // транзиентные коды HH — повторяем
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
            const ra = Number(res.headers.get("retry-after"));
            await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * (attempt + 1));
            continue;
        }
        throw new Error(`HH GET ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    throw lastErr;
}

// ===== Типы (минимально нужные поля) =====

export interface HhAction {
    id: string;
    url: string;
    method: string;
}

export interface HhMessage {
    id?: string;
    created_at?: string;
    text?: string;
    author?: { participant_type?: string };
}

export interface HhNegotiation {
    id: string;
    /** Статус со стороны кандидата. НЕ отражает воронку работодателя: остаётся
     *  «response» даже после перевода в «Первичный контакт». Для решений о стадии
     *  используй employer_state / employerStage(). */
    state?: { id?: string; name?: string };
    /** Реальная стадия в воронке работодателя — её меняют действия HH. */
    employer_state?: { id?: string; name?: string };
    created_at?: string;
    updated_at?: string;
    url?: string;
    messages_url?: string;
    actions?: HhAction[];
    resume?: {
        id?: string;
        url?: string;
        alternate_url?: string;
        title?: string;
        first_name?: string;
        last_name?: string;
        middle_name?: string;
        age?: number;
        area?: { name?: string };
        total_experience?: { months?: number };
        education?: { level?: { name?: string } };
    };
}

/** Новые отклики по вакансии (стадия "Отклики") */
export async function getNewResponses(vacancyId: string): Promise<HhNegotiation[]> {
    const url = `${API_BASE}/negotiations/response?vacancy_id=${encodeURIComponent(vacancyId)}&per_page=50`;
    const data = await apiGet(url);
    return data.items || [];
}

/** Все страницы новых откликов. Используется часовым анализатором, чтобы не терять записи после первых 50. */
export async function getAllNewResponses(vacancyId: string): Promise<HhNegotiation[]> {
    return getAllNegotiationsByCollection("response", vacancyId);
}

/** Отклики в стадии "Подумать" (consider) */
export async function getConsiderResponses(vacancyId: string): Promise<HhNegotiation[]> {
    const url = `${API_BASE}/negotiations/consider?vacancy_id=${encodeURIComponent(vacancyId)}&per_page=50`;
    const data = await apiGet(url);
    return data.items || [];
}

/** Все страницы стадии «Подумать». */
export async function getAllConsiderResponses(vacancyId: string): Promise<HhNegotiation[]> {
    return getAllNegotiationsByCollection("consider", vacancyId);
}

/** Отклики в стадии «Первичный контакт» (phone_interview) */
export async function getPhoneInterviewResponses(vacancyId: string): Promise<HhNegotiation[]> {
    const url = `${API_BASE}/negotiations/phone_interview?vacancy_id=${encodeURIComponent(vacancyId)}&per_page=50`;
    const data = await apiGet(url);
    return data.items || [];
}

export interface HhCollectionCount {
    id: string;
    name: string;
    total: number;
}

/** Все коллекции (стадии) вакансии с русскими названиями и счётчиками — один запрос. */
export async function getNegotiationCollections(vacancyId: string): Promise<HhCollectionCount[]> {
    const d = await apiGet(`${API_BASE}/negotiations?vacancy_id=${encodeURIComponent(vacancyId)}`);
    return (d.collections || []).map((c: any) => ({
        id: String(c.id),
        name: String(c.name || c.id),
        total: Number(c.counters?.total ?? c.found ?? 0),
    }));
}

/** Страница переговоров конкретной коллекции вакансии. */
export async function getNegotiationsByCollection(collection: string, vacancyId: string, page = 0): Promise<any> {
    return apiGet(`${API_BASE}/negotiations/${encodeURIComponent(collection)}?vacancy_id=${encodeURIComponent(vacancyId)}&per_page=50&page=${page}`);
}

/** Постранично читает коллекцию HH до конца. */
export async function getAllNegotiationsByCollection(
    collection: string,
    vacancyId: string,
    maxPages = 100,
): Promise<HhNegotiation[]> {
    const all: HhNegotiation[] = [];
    for (let page = 0; page < maxPages; page++) {
        const data = await getNegotiationsByCollection(collection, vacancyId, page);
        const items: HhNegotiation[] = Array.isArray(data?.items) ? data.items : [];
        all.push(...items);

        const pages = Number(data?.pages);
        if (Number.isFinite(pages) && pages > 0) {
            if (page + 1 >= pages) break;
        } else if (items.length < 50) {
            break;
        }
    }
    return all;
}

/** Один отклик по его id (в любой стадии) — с текущим состоянием и доступными действиями */
export async function getNegotiation(id: string): Promise<HhNegotiation | null> {
    try {
        return await apiGet(`${API_BASE}/negotiations/${encodeURIComponent(id)}`);
    } catch {
        return null;
    }
}

/** Полное резюме по отклику */
export async function getResume(resumeId: string, topicId: string, vacancyId: string): Promise<any> {
    const url = `${API_BASE}/resumes/${encodeURIComponent(resumeId)}?topic_id=${encodeURIComponent(topicId)}&vacancy_id=${encodeURIComponent(vacancyId)}`;
    return apiGet(url);
}

/** Описание вакансии */
export async function getVacancy(vacancyId: string): Promise<any> {
    return apiGet(`${API_BASE}/vacancies/${encodeURIComponent(vacancyId)}`);
}

/**
 * Действие над откликом (consider / phone_interview / discard_by_employer и т.п.).
 * HH принимает PUT/POST с form-urlencoded; можно приложить сообщение кандидату.
 */
export async function doNegotiationAction(url: string, method: string = "PUT", message?: string): Promise<void> {
    const headers = await authHeaders({ "Content-Type": "application/x-www-form-urlencoded" });
    const body = message ? new URLSearchParams({ message }).toString() : undefined;
    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HH ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
}

/** Отправка сообщения кандидату в переписку отклика */
/**
 * Вся переписка целиком. HH отдаёт сообщения страницами по 20 — без обхода страниц
 * возвращались только первые 20, поэтому в длинных диалогах бот не видел ни свежих
 * ответов кандидата, ни собственных отправленных писем.
 */
export async function getConversationMessages(messagesUrl: string): Promise<HhMessage[]> {
    const sep = messagesUrl.includes("?") ? "&" : "?";
    const all: HhMessage[] = [];
    for (let page = 0; page < 50; page++) {
        const data = await apiGet(`${messagesUrl}${sep}per_page=100&page=${page}`);
        const items: HhMessage[] = Array.isArray(data?.items) ? data.items : [];
        all.push(...items);
        const pages = Number(data?.pages);
        if (Number.isFinite(pages) && pages > 0) {
            if (page + 1 >= pages) break;
        } else if (items.length < 100) {
            break;
        }
    }
    return all;
}

export async function sendCandidateMessage(messagesUrl: string, text: string): Promise<void> {
    const headers = await authHeaders({ "Content-Type": "application/x-www-form-urlencoded" });
    const body = new URLSearchParams({ message: text }).toString();
    const res = await fetch(messagesUrl, { method: "POST", headers, body });
    if (!res.ok) {
        const t = await res.text();
        throw new Error(`HH POST ${messagesUrl} → ${res.status}: ${t.slice(0, 300)}`);
    }
}

/** Есть ли в переписке уже сообщение от работодателя (нас) */
export async function hasEmployerMessage(messagesUrl: string): Promise<boolean> {
    try {
        const data = await apiGet(messagesUrl);
        const items = data.items || [];
        // Пустые сообщения (text null/пусто) не считаем — иначе дедуп решит, что уже писали, и не отправит реальный шаблон
        return items.some((m: any) => m?.author?.participant_type === "employer" && String(m?.text || "").trim() !== "");
    } catch {
        return false;
    }
}

function normalizeMessageText(text: string): string {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function messageUrls(text: string): string[] {
    return (String(text || "").match(/https?:\/\/[^\s<>]+/gi) || [])
        .map((url) => url.replace(/[),.!?;:]+$/g, "").toLowerCase());
}

/** Проверяет наличие именно нужного шаблона, а не любого сообщения работодателя. */
export async function hasEmployerMessageText(messagesUrl: string, expectedText: string): Promise<boolean> {
    if (!messagesUrl || !String(expectedText || "").trim()) return false;
    try {
        const data = await apiGet(messagesUrl);
        const expected = normalizeMessageText(expectedText);
        const expectedUrls = messageUrls(expectedText);
        return (data.items || []).some((message: any) => {
            if (message?.author?.participant_type !== "employer") return false;
            const actualText = String(message?.text || "");
            if (normalizeMessageText(actualText) === expected) return true;
            if (expectedUrls.length === 0) return false;
            const actualUrls = new Set(messageUrls(actualText));
            return expectedUrls.some((url) => actualUrls.has(url));
        });
    } catch {
        return false;
    }
}

/** Отправка сообщения только если конкретный шаблон ещё не отправлялся. */
export async function sendCandidateMessageOnce(messagesUrl: string, text: string): Promise<boolean> {
    if (!messagesUrl) return false;
    if (await hasEmployerMessageText(messagesUrl, text)) return false;
    await sendCandidateMessage(messagesUrl, text);
    return true;
}

/** Вытаскивает нужные action-ы из отклика в плоский вид */
/**
 * Стадия отклика в воронке работодателя.
 * HH отдаёт два поля: `state` (статус со стороны кандидата, залипает на «response»)
 * и `employer_state` (реальная стадия воронки, её меняют действия). Все решения о
 * стадии должны опираться на это значение, иначе бот бесконечно повторяет переводы.
 */
export function employerStage(n: HhNegotiation): { id?: string; name?: string } {
    return n.employer_state || n.state || {};
}

export function extractActions(n: HhNegotiation) {
    const find = (id: string) => n.actions?.find((a) => a.id === id);
    const consider = find("consider");
    const phone = find("phone_interview");
    const assessment = find("assessment");
    const interview = find("interview");
    const discard = find("discard_by_employer");
    return {
        action_consider_url: consider?.url || "",
        action_consider_method: consider?.method || "PUT",
        action_phone_interview_url: phone?.url || "",
        action_phone_interview_method: phone?.method || "PUT",
        action_assessment_url: assessment?.url || "",
        action_assessment_method: assessment?.method || "PUT",
        action_interview_url: interview?.url || "",
        action_interview_method: interview?.method || "PUT",
        action_discard_url: discard?.url || "",
        action_discard_method: discard?.method || "PUT",
    };
}
