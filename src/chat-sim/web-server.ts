import express from "express";
import type { Bot } from "grammy";
import { listTrackedVacancies } from "./vacancies";
import { createSession, getSession } from "./state.store";
import { handleSimulatedQuestion } from "./service";

const CHAT_SIM_PORT = Number(process.env.CHAT_SIM_PORT) || 3001;

function htmlPage() {
    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HH Chat Simulator</title>
  <style>
    :root {
      --bg: #f4efe7;
      --panel: #fffaf2;
      --border: #d9cdbf;
      --text: #1f1a17;
      --muted: #74675b;
      --accent: #a6441b;
      --accent-soft: #f2d6c8;
      --ai: #efe4d3;
      --candidate: #f8f1e8;
      --system: #f3e9b6;
    }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background: linear-gradient(180deg, #f7f0e8 0%, #efe5d7 100%);
      color: var(--text);
    }
    .wrap {
      max-width: 980px;
      margin: 0 auto;
      padding: 24px 16px 40px;
    }
    .hero {
      margin-bottom: 18px;
    }
    .hero h1 {
      margin: 0 0 8px;
      font-size: 36px;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 720px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 10px 30px rgba(63, 42, 20, 0.08);
    }
    .controls {
      display: grid;
      gap: 12px;
      margin-bottom: 16px;
    }
    .row {
      display: grid;
      gap: 12px;
      grid-template-columns: 1fr auto;
    }
    select, textarea, button {
      font: inherit;
    }
    select, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #fff;
      padding: 12px 14px;
      box-sizing: border-box;
    }
    textarea {
      min-height: 110px;
      resize: vertical;
    }
    button {
      border: 0;
      border-radius: 12px;
      background: var(--accent);
      color: #fff;
      padding: 12px 16px;
      cursor: pointer;
    }
    button.secondary {
      background: #dbc4a8;
      color: #3b2a14;
    }
    .status {
      min-height: 24px;
      color: var(--muted);
      margin-bottom: 12px;
    }
    .chat {
      display: grid;
      gap: 12px;
    }
    .msg {
      border-radius: 14px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      white-space: pre-wrap;
    }
    .candidate { background: var(--candidate); }
    .assistant { background: var(--ai); }
    .system { background: var(--system); }
    .meta {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    @media (max-width: 720px) {
      .row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1>HH Chat Simulator</h1>
      <p>Здесь можно руками эмулировать вопросы кандидата по конкретной вакансии. Если база знаний подходит, ответит ИИ. Если нет, вопрос уйдёт в Telegram-тему вакансии.</p>
    </div>
    <div class="panel">
      <div class="controls">
        <div class="row">
          <select id="vacancy"></select>
          <button class="secondary" id="newSession">Новый диалог</button>
        </div>
        <textarea id="question" placeholder="Напиши вопрос кандидата здесь"></textarea>
        <div class="row">
          <div class="status" id="status"></div>
          <button id="send">Отправить вопрос</button>
        </div>
      </div>
      <div class="chat" id="chat"></div>
    </div>
  </div>
  <script>
    let sessionId = null;
    let currentVacancy = null;
    let pollTimer = null;

    async function request(url, options) {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(data.error || response.statusText);
      }
      return response.json();
    }

    function setStatus(text) {
      document.getElementById('status').textContent = text || '';
    }

    function renderChat(session) {
      const root = document.getElementById('chat');
      root.innerHTML = '';
      if (!session || !session.messages.length) return;

      for (const msg of session.messages) {
        const node = document.createElement('div');
        node.className = 'msg ' + msg.role;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = msg.role + ' / ' + msg.source;
        const body = document.createElement('div');
        body.textContent = msg.text;
        node.appendChild(meta);
        node.appendChild(body);
        root.appendChild(node);
      }
    }

    async function refreshSession() {
      if (!sessionId) return;
      const session = await request('/api/chat-sim/session/' + sessionId);
      renderChat(session);
    }

    async function createNewSession() {
      currentVacancy = document.getElementById('vacancy').value;
      const data = await request('/api/chat-sim/session', {
        method: 'POST',
        body: JSON.stringify({ vacancyName: currentVacancy }),
      });
      sessionId = data.id;
      renderChat(data);
      setStatus('Новый диалог создан');
    }

    async function loadVacancies() {
      const vacancies = await request('/api/chat-sim/vacancies');
      const select = document.getElementById('vacancy');
      select.innerHTML = '';
      for (const vacancy of vacancies) {
        const option = document.createElement('option');
        option.value = vacancy.vacancyName;
        option.textContent = vacancy.vacancyName;
        select.appendChild(option);
      }
      if (vacancies.length) {
        await createNewSession();
      }
    }

    async function sendQuestion() {
      const textarea = document.getElementById('question');
      const question = textarea.value.trim();
      if (!question) return;
      if (!sessionId) await createNewSession();

      setStatus('Отправляю вопрос...');
      const result = await request('/api/chat-sim/message', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          vacancyName: document.getElementById('vacancy').value,
          question,
        }),
      });

      textarea.value = '';
      renderChat(result.session);
      setStatus(result.status === 'answered'
        ? 'ИИ ответил кандидату'
        : 'Вопрос отправлен в Telegram и ждёт reply');
    }

    document.getElementById('send').addEventListener('click', () => {
      sendQuestion().catch((error) => setStatus(error.message));
    });
    document.getElementById('newSession').addEventListener('click', () => {
      createNewSession().catch((error) => setStatus(error.message));
    });

    pollTimer = setInterval(() => {
      refreshSession().catch((error) => setStatus(error.message));
    }, 3000);

    loadVacancies().catch((error) => setStatus(error.message));
  </script>
</body>
</html>`;
}

export function startChatSimServer(bot: Bot) {
    const app = express();
    app.use(express.json());

    app.get("/chat-sim", (_req, res) => {
        res.type("html").send(htmlPage());
    });

    app.get("/api/chat-sim/vacancies", async (_req, res) => {
        try {
            const vacancies = await listTrackedVacancies();
            res.json(vacancies.map((vacancy) => ({ vacancyName: vacancy.vacancyName })));
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post("/api/chat-sim/session", async (req, res) => {
        try {
            const vacancyName = String(req.body?.vacancyName || "").trim();
            if (!vacancyName) {
                res.status(400).json({ error: "vacancyName обязателен" });
                return;
            }
            const session = createSession(vacancyName);
            res.json(session);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get("/api/chat-sim/session/:sessionId", (req, res) => {
        const session = getSession(req.params.sessionId);
        if (!session) {
            res.status(404).json({ error: "Сессия не найдена" });
            return;
        }
        res.json(session);
    });

    app.post("/api/chat-sim/message", async (req, res) => {
        try {
            const result = await handleSimulatedQuestion(bot, {
                sessionId: req.body?.sessionId,
                vacancyName: req.body?.vacancyName,
                question: req.body?.question,
            });
            res.json(result);
        } catch (error: any) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get("/api/chat-sim/health", (_req, res) => {
        res.json({ ok: true });
    });

    app.listen(CHAT_SIM_PORT, () => {
        console.log(`[chat-sim] сервер запущен на порту ${CHAT_SIM_PORT}`);
    });
}
