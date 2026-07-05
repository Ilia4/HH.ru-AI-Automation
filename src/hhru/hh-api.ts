import { getValidAccessToken } from "../hh-auth/hh-auth.service";

const API_BASE = "https://api.hh.ru";
const USER_AGENT = process.env.HH_USER_AGENT || "hr-tg-bot/1.0 (gf12658@gmail.com)";

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await getValidAccessToken();
    if (!token) throw new Error("Нет токена HH.ru — нужна авторизация (/auth)");
    return {
        Authorization: `Bearer ${token}`,
        "HH-User-Agent": USER_AGENT,
        ...extra,
    };
}

/** GET-запрос к HH API с авторизацией */
async function apiGet(url: string): Promise<any> {
    const res = await fetch(url, { headers: await authHeaders() });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HH GET ${url} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
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
    state?: { id?: string; name?: string };
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

/** Отклики в стадии "Подумать" (consider) */
export async function getConsiderResponses(vacancyId: string): Promise<HhNegotiation[]> {
    const url = `${API_BASE}/negotiations/consider?vacancy_id=${encodeURIComponent(vacancyId)}&per_page=50`;
    const data = await apiGet(url);
    return data.items || [];
}

/** Отклики в стадии «Первичный контакт» (phone_interview) */
export async function getPhoneInterviewResponses(vacancyId: string): Promise<HhNegotiation[]> {
    const url = `${API_BASE}/negotiations/phone_interview?vacancy_id=${encodeURIComponent(vacancyId)}&per_page=50`;
    const data = await apiGet(url);
    return data.items || [];
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
export async function getConversationMessages(messagesUrl: string): Promise<HhMessage[]> {
    const data = await apiGet(messagesUrl);
    return data.items || [];
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

/** Отправка сообщения только если мы ещё не писали кандидату (защита от дублей). Возвращает true если отправили. */
export async function sendCandidateMessageOnce(messagesUrl: string, text: string): Promise<boolean> {
    if (!messagesUrl) return false;
    if (await hasEmployerMessage(messagesUrl)) return false;
    await sendCandidateMessage(messagesUrl, text);
    return true;
}

/** Вытаскивает нужные action-ы из отклика в плоский вид */
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
