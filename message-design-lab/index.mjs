import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

function readEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

const env = { ...readEnv(path.join(rootDir, ".env")), ...process.env };
const ownerFile = path.join(rootDir, "owner-chat-id.txt");
const settingsFile = path.join(rootDir, "settings.json");
const topicsFileCandidates = [
  env.TOPICS_FILE,
  path.join(rootDir, "topics.json"),
  path.resolve(rootDir, "..", "hr-tg-bot", "topics.json"),
].filter(Boolean);

const commonRejectTemplate = `Здравствуйте, [Name]!

Благодарим за интерес к вакансии «[Vacancy]». К сожалению, сейчас мы не готовы пригласить вас на следующий этап отбора.

С уважением, компания ZaVOZ.PRO.`;

const questionnaireSuitableTemplate = `Здравствуйте, [Name]!

Ваше резюме по вакансии «[Vacancy]» прошло первичный отбор. Для дальнейшего рассмотрения заполните, пожалуйста, небольшую анкету по ссылке: [QuestionnaireLink]

С уважением, компания ZaVOZ.PRO.`;

const chatQuestionSuitableTemplate = `Здравствуйте, [Name]!

Благодарим за интерес к вакансии «[Vacancy]». Ваш опыт показался нам интересным. Напишите, пожалуйста, несколько слов: чем вас заинтересовала наша вакансия?

С уважением, компания ZaVOZ.PRO.`;

const stageSuitableTemplate = `Здравствуйте, [Name]!

Благодарим за ответы по вакансии «[Vacancy]». Хотим пригласить вас на собеседование. Напишите, пожалуйста, в какие дни и время вам удобно встретиться.

С уважением, компания ZaVOZ.PRO.`;

const stageRejectTemplate = `Здравствуйте, [Name]!

Благодарим за уделённое время и ответы по вакансии «[Vacancy]». К сожалению, по итогам этого этапа мы не готовы продолжить отбор.

С уважением, компания ZaVOZ.PRO.`;

function defaultTemplates(resumeSuitable) {
  return {
    resumeSuitable,
    resumeReject: commonRejectTemplate,
    stageSuitable: stageSuitableTemplate,
    stageReject: stageRejectTemplate,
  };
}

function autoPlusFilter(text) {
  return { text, scoring: { mode: "auto", direction: "plus" } };
}

const demoVacancies = [
  {
    id: "volunteers",
    name: "Специалист по работе с волонтёрскими организациями/Менеджер по продажам",
    defaults: {
      active: true,
      workflow: "chat_question",
      minScore: 7,
      filters: [autoPlusFilter("Опыт общения с клиентами или партнёрами"), autoPlusFilter("Готовность работать в Воронеже")],
      templates: defaultTemplates(chatQuestionSuitableTemplate),
    },
  },
  {
    id: "project-manager",
    name: "Менеджер / руководитель проектов",
    defaults: {
      active: true,
      workflow: "questionnaire",
      minScore: 7,
      filters: [autoPlusFilter("Опыт самостоятельного ведения проектов"), autoPlusFilter("Умение работать с неопределёнными требованиями")],
      templates: defaultTemplates(questionnaireSuitableTemplate),
    },
  },
  {
    id: "3d-project",
    name: "Руководитель проекта — направление 3D-печати",
    defaults: {
      active: true,
      workflow: "questionnaire",
      minScore: 7,
      filters: [autoPlusFilter("Практический опыт прототипирования или 3D-печати")],
      templates: defaultTemplates(questionnaireSuitableTemplate),
    },
  },
  {
    id: "agency-sales",
    name: "Руководитель агентского канала продаж",
    defaults: {
      active: false,
      workflow: "questionnaire",
      minScore: 7,
      filters: [autoPlusFilter("Опыт запуска агентского или партнёрского канала")],
      templates: defaultTemplates(questionnaireSuitableTemplate),
    },
  },
  {
    id: "production",
    name: "Начальник производства",
    defaults: {
      active: true,
      workflow: "questionnaire",
      minScore: 7,
      filters: [autoPlusFilter("Опыт управления производством"), autoPlusFilter("Опыт работы с металлообработкой")],
      templates: defaultTemplates(questionnaireSuitableTemplate),
    },
  },
];

const vacancyTopicAliases = {
  volunteers: ["специалист по работе с волонтёрскими организациями", "менеджер по продажам"],
  "project-manager": ["менеджер руководитель проектов", "менеджер проектов"],
  "3d-project": ["3d печати", "3д печати"],
  "agency-sales": ["руководитель агентского канала продаж"],
  production: ["начальник производства"],
};

const demoCandidates = [
  {
    id: "vol-answer-1",
    vacancyId: "volunteers",
    name: "Денисенко Сергей Сергеевич",
    task: "answer",
    score: 8,
    date: "28.08.2026 10:15",
    resumeUrl: "https://hh.ru/",
    summary: "Опыт общения с клиентами соответствует вакансии. Кандидат мотивирован и готов продолжить отбор.",
    candidateText: "Здравствуйте! Анкету заполнил, надеюсь на дальнейшее сотрудничество.",
  },
  {
    id: "vol-resume-1",
    vacancyId: "volunteers",
    name: "Богомолова Елена Юрьевна",
    task: "resume",
    score: 6,
    date: "28.08.2026 09:40",
    resumeUrl: "https://hh.ru/",
    summary: "Есть релевантный опыт общения и организации мероприятий, но опыт продаж раскрыт недостаточно.",
  },
  {
    id: "pm-form-1",
    vacancyId: "project-manager",
    name: "Кровякова Светлана",
    task: "questionnaire",
    score: 5.4,
    date: "27.08.2026 16:20",
    resumeUrl: "https://hh.ru/",
    summary: "Практический опыт есть, но ответы на ключевые вопросы анкеты заполнены неполно.",
    candidateText: "Сильнее всего раскрыт опыт создания макетов и самостоятельной сборки изделий. Нет ответов о методологиях и сроках проектов.",
  },
  {
    id: "3d-form-1",
    vacancyId: "3d-project",
    name: "Колбасин Евгений Олегович",
    task: "questionnaire",
    score: 7.4,
    date: "28.08.2026 21:05",
    resumeUrl: "https://hh.ru/",
    summary: "Сильный практический опыт 3D-печати, реверс-инжиниринга и прототипирования.",
    candidateText: "Хорошо раскрыты работа без чертежей, анализ поломок и проверка прототипов в реальных условиях.",
  },
  {
    id: "agency-resume-1",
    vacancyId: "agency-sales",
    name: "Аршавский Станислав",
    task: "resume",
    score: 6,
    date: "28.08.2026 16:13",
    resumeUrl: "https://hh.ru/",
    summary: "Есть опыт запуска продаж и работы с агентами, но часть результатов требует ручной проверки.",
  },
  {
    id: "prod-form-1",
    vacancyId: "production",
    name: "Цыганков Александр Викторович",
    task: "questionnaire",
    score: 5,
    date: "29.08.2026 14:08",
    resumeUrl: "https://hh.ru/",
    summary: "Есть управленческий опыт в производстве, но ответы слишком краткие для уверенного решения.",
    candidateText: "Нужно дополнительно проверить управление цехом, производственными показателями и персоналом.",
  },
  {
    id: "prod-resume-1",
    vacancyId: "production",
    name: "Паршина Анна Александровна",
    task: "resume",
    score: 5,
    date: "29.08.2026 13:52",
    resumeUrl: "https://hh.ru/",
    summary: "Есть операционный и складской управленческий опыт, но нет подтверждённого опыта металлообработки.",
  },
];

const workflowLabels = {
  questionnaire: "Анкета после анализа резюме",
  chat_question: "Вопрос кандидату в HH после анализа",
};

const templateKeys = ["resumeSuitable", "resumeReject", "stageSuitable", "stageReject"];

function templateLabel(workflow, key) {
  const stageName = workflow === "questionnaire" ? "анкеты" : "ответа в HH";
  return {
    resumeSuitable: workflow === "questionnaire" ? "После резюме: отправить анкету" : "После резюме: задать вопрос в HH",
    resumeReject: "После резюме: отказ",
    stageSuitable: `После ${stageName}: приглашение`,
    stageReject: `После ${stageName}: отказ`,
  }[key] || key;
}

function normalizeFilter(raw) {
  if (typeof raw === "string") return autoPlusFilter(raw.trim());
  const text = String(raw?.text || "").trim();
  const mode = raw?.scoring?.mode === "fixed" ? "fixed" : "auto";
  if (mode === "fixed") {
    const points = Number(raw?.scoring?.points);
    return { text, scoring: { mode, points: Number.isFinite(points) && points !== 0 ? points : 1 } };
  }
  return {
    text,
    scoring: { mode, direction: raw?.scoring?.direction === "minus" ? "minus" : "plus" },
  };
}

function filterWeightLabel(filter) {
  const normalized = normalizeFilter(filter);
  if (normalized.scoring.mode === "fixed") {
    const points = normalized.scoring.points;
    return `${points > 0 ? "+" : "−"}${String(Math.abs(points)).replace(".", ",")}`;
  }
  return normalized.scoring.direction === "minus" ? "Авто −" : "Авто +";
}

const legacyWorkflowAliases = {
  resume_questionnaire: "questionnaire",
  resume_only: "chat_question",
};

const designs = {
  recommended: "Единый понятный дизайн",
};

const scenarios = [
  {
    name: "Обычное сообщение кандидата по отклику",
    text: `📥 Сообщение кандидата (отклик) — «Специалист по работе с волонтёрскими организациями/Менеджер по продажам», Денисенко Сергей Сергеевич:

Здравствуйте, благодарен за интерес к моему резюме, анкету заполнил, надеюсь на дальнейшее сотрудничество!

👤 Резюме: https://hh.ru/resume/test-candidate

Это не вопрос — бот не отвечал. При необходимости ответьте кандидату вручную в HH.

#Денисенко_Сергей_Сергеевич`,
    replyKind: "candidate",
  },
  {
    name: "Вопрос кандидата без ответа в базе знаний",
    text: `❓ Вопрос кандидата по вакансии «Менеджер проектов» (Фёдорова Елена Андреевна) — в базе знаний ответа нет.

Вопрос кандидата:
Подскажите, пожалуйста, предусмотрено ли обучение в первые недели работы?

Ответьте reply на это сообщение — бот отправит ваш ответ кандидату в чат HH.

#Фёдорова_Елена_Андреевна`,
    replyKind: "candidate",
  },
  {
    name: "Вопрос с кнопкой карточки кандидата",
    text: `❓ Вопрос кандидата по вакансии «Начальник производства» (Иванов Иван Иванович) — в базе знаний ответа нет.

Вопрос кандидата:
Какой график работы предусмотрен на производстве?

Ответьте reply на это сообщение — бот отправит ваш ответ кандидату в чат HH.

#Иванов_Иван_Иванович

💡 Подробнее — в карточке кандидата: оценка резюме, ответы и вся переписка.`,
    buttons: [["Открыть карточку кандидата", "test:card"]],
    replyKind: "candidate",
  },
  {
    name: "Сообщение по архивной вакансии",
    text: `🗄 «Руководитель агентского канала продаж» в архиве — кандидат Михайлов Олег Ильич написал, бот ответить не может.
Ответьте вручную в HH:

Добрый день! Подскажите, вакансия ещё актуальна?`,
  },
  {
    name: "Кандидат предложил точный слот",
    text: `🗓 Кандидат ответил по собеседованию: Богомолова Елена Юрьевна
Вакансия: Специалист по работе с волонтёрскими организациями/Менеджер по продажам

Сообщение кандидата:
Мне будет удобно во вторник 25.08 в 11:00.

Кандидат предлагает слот: 2026-08-25 11:00

Ответьте reply на это сообщение.
Бот сам классифицирует ответ: подтверждение, новый слот или уточнение.

#Богомолова_Елена_Юрьевна`,
    replyKind: "interview",
  },
  {
    name: "Точный слот не распознан",
    text: `🗓 Кандидат ответил по собеседованию: Богомолова Елена Юрьевна
Вакансия: Специалист по работе с волонтёрскими организациями/Менеджер по продажам

Сообщение кандидата:
Можно перенести на следующую неделю в первой половине дня?

Точный слот из сообщения кандидата не распознан.

Ответьте reply на это сообщение.
Бот сам классифицирует ответ: подтверждение, новый слот или уточнение.

#Богомолова_Елена_Юрьевна`,
    replyKind: "interview",
  },
  {
    name: "Собеседование назначено",
    text: `✅ Собеседование назначено
Кандидат: Богомолова Елена Юрьевна
Вакансия: Специалист по работе с волонтёрскими организациями/Менеджер по продажам
Когда: 25.08.2026 в 11:00`,
  },
  {
    name: "Запрос решения по встрече",
    text: `🗓 Нужно ваше решение по собеседованию
Кандидат: Богомолова Елена Юрьевна
Вакансия: Специалист по работе с волонтёрскими организациями/Менеджер по продажам
Когда: 25.08.2026 в 11:00

Собеседование скоро.
Подтверждаем встречу или отменяем? Выберите ниже 👇

#Богомолова_Елена_Юрьевна`,
    buttons: [["📨 Спросить кандидата", "test:confirm"], ["❌ Отменить встречу", "test:cancel"]],
  },
  {
    name: "Встреча подтверждена кандидатом",
    text: `✅ ПОДТВЕРЖДЕНО — Богомолова Елена Юрьевна («Специалист по работе с волонтёрскими организациями/Менеджер по продажам»). Ответ кандидата: «Да, всё в силе»

#Богомолова_Елена_Юрьевна`,
  },
  {
    name: "Встреча не подтверждена — перенос",
    text: `♻️ НЕ ПОДТВЕРЖДЕНО (перенос) — Богомолова Елена Юрьевна (Специалист по работе с волонтёрскими организациями/Менеджер по продажам). Ответ: «Сегодня не смогу, можно завтра?». Бронь снята с календаря. Согласуем новое время.

#Богомолова_Елена_Юрьевна`,
  },
  {
    name: "Неясный ответ по встрече",
    text: `❓ НЕЯСНО — Богомолова Елена Юрьевна (Специалист по работе с волонтёрскими организациями/Менеджер по продажам) ответила: «Пока точно не знаю». Гляньте вручную.

#Богомолова_Елена_Юрьевна`,
  },
  {
    name: "Обычное сообщение после назначения",
    text: `💬 Сообщение кандидата (Богомолова Елена Юрьевна, «Специалист по работе с волонтёрскими организациями/Менеджер по продажам»):
Спасибо Вам 🙂

↩️ Ответьте reply на это сообщение — текст уйдёт кандидату в HH.

#Богомолова_Елена_Юрьевна`,
    replyKind: "candidate",
  },
  {
    name: "Настоящий перенос назначенной встречи",
    text: `♻️ ПЕРЕНОС — Богомолова Елена Юрьевна («Специалист по работе с волонтёрскими организациями/Менеджер по продажам») написала:
«Не смогу приехать 25.08. Можно перенести на 26.08 в 14:00?»
Бронь 25.08.2026 11:00 снята с календаря.

↩️ Ответьте reply — предложу кандидату новое время.

#Богомолова_Елена_Юрьевна`,
    replyKind: "interview",
  },
  {
    name: "Список кандидатов архивной вакансии",
    text: `🗄 «Руководитель агентского канала продаж» в архиве на HH — напишите вручную (часть 1/2, всего 50):

1. Макаров Андрей Александрович — резюме на HH
2. Байрамалиев Артур — резюме на HH
3. Клейменова Кристина Олеговна — резюме на HH
4. Глухова Анастасия Васильевна — резюме на HH
5. Миронова Юлия Сергеевна — резюме на HH`,
  },
  {
    name: "Сводка с новыми откликами",
    text: `📊 Начальник производства
👤 Аккаунт HH: hr@example.ru
🕐 Период: 11:00 — 12:00

Новые отклики:
👥 Всего: 12
✅ Прошли: 5
🤔 На проверку: 3
❌ Отказ: 4

Ручная проверка:
📋 Обработано: 2
✅ Принято: 1
❌ Отклонено: 1`,
  },
  {
    name: "Сводка без новых откликов",
    text: `📊 Начальник производства
👤 Аккаунт HH: hr@example.ru
🕐 Период: 12:00 — 13:00
📭 Новых откликов за период не было`,
  },
  {
    name: "Назначение ответственного за вакансию",
    text: `🎯 Вас назначили ответственным за вакансию

Вакансия: Начальник производства
Ссылка: https://hh.ru/vacancy/test
Шаблоны: Google-таблица вакансии
Если по вакансии будут назначены собеседования, я пришлю уведомление 🙂`,
  },
  {
    name: "Личное уведомление о собеседовании",
    text: `📋 Назначено собеседование

Вакансия: Начальник производства
Кандидат: Иванов Иван Иванович
Дата: 27.08.2026
Время: 15:30
Резюме: https://hh.ru/resume/test-candidate
Связь с кандидатом: +7 900 000-00-00`,
  },
  {
    name: "Напоминание за 30 минут",
    text: `⏰ Через 30 минут собеседование

Вакансия: Начальник производства
Кандидат: Иванов Иван Иванович
Время: 15:30
Связь с кандидатом: +7 900 000-00-00`,
  },
  {
    name: "Расписание собеседований",
    text: `📅 Собеседования — Начальник производства

27.08.2026
• 11:00 — Петрова Анна Сергеевна
• 15:30 — Иванов Иван Иванович

28.08.2026
• 10:00 — Сидоров Павел Олегович`,
  },
  {
    name: "Расписание пустое",
    text: `📅 Собеседования — Начальник производства

Собеседований пока не назначено.`,
  },
  { name: "Обработка уже выполняется", text: "⏳ Обработка уже идёт. Дождитесь её завершения и попробуйте снова." },
  { name: "Ошибка команды", text: "Ошибка ❌ Смотрите журнал работы бота." },
];

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function emphasizeLabels(text) {
  return text.split("\n").map((line) => {
    const match = line.match(/^([^:]{1,45}):\s*(.*)$/);
    return match ? `<b>${escapeHtml(match[1])}:</b> ${escapeHtml(match[2])}` : escapeHtml(line);
  }).join("\n");
}

function buildCard({ header, fields = [], stage, quoteLabel, quote, details = [], status, action, links = [], tag }) {
  const blocks = [`<b>${escapeHtml(header)}</b>`];
  if (fields.length || stage) {
    const info = fields.map(([icon, label, value]) => `${icon} <b>${escapeHtml(label)}:</b> ${escapeHtml(value)}`);
    if (stage) info.push(`📍 <b>Этап кандидата:</b> ${escapeHtml(stage)}`);
    blocks.push(info.join("\n"));
  }
  if (quote) {
    blocks.push(`<b>${escapeHtml(quoteLabel || "Сообщение кандидата")}</b>\n<blockquote>${escapeHtml(quote)}</blockquote>`);
  }
  if (details.length) blocks.push(details.map(escapeHtml).join("\n"));
  if (action) blocks.push(`👉 <b>Что нужно сделать:</b> ${escapeHtml(action)}`);
  if (links.length) {
    blocks.push(links.map(([label, url]) => `🔗 <a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`).join("\n"));
  }
  if (tag) blocks.push(`<code>${escapeHtml(tag)}</code>`);
  return blocks.join("\n\n");
}

const recommendedCards = [
  buildCard({
    header: "📥 НОВОЕ СООБЩЕНИЕ ПО ОТКЛИКУ",
    fields: [["👤", "Кандидат", "Денисенко Сергей Сергеевич"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"]],
    stage: "Анализ анкеты",
    quote: "Здравствуйте, благодарен за интерес к моему резюме, анкету заполнил, надеюсь на дальнейшее сотрудничество!",
    status: "Не отвечал — сообщение не содержит вопроса.",
    action: "При необходимости ответьте reply на это сообщение — ответ уйдёт кандидату в HH.",
    links: [["Открыть тестовое резюме на HH", "https://hh.ru"]],
    tag: "#Денисенко_Сергей_Сергеевич",
  }),
  buildCard({
    header: "❓ КАНДИДАТУ НУЖЕН ОТВЕТ",
    fields: [["👤", "Кандидат", "Фёдорова Елена Андреевна"], ["💼", "Вакансия", "Менеджер проектов"]],
    stage: "Анализ резюме",
    quote: "Подскажите, пожалуйста, предусмотрено ли обучение в первые недели работы?",
    status: "Не нашёл подходящего ответа в базе знаний.",
    action: "Ответьте reply на это сообщение — ответ уйдёт кандидату в HH.",
    tag: "#Фёдорова_Елена_Андреевна",
  }),
  buildCard({
    header: "❓ КАНДИДАТУ НУЖЕН ОТВЕТ",
    fields: [["👤", "Кандидат", "Иванов Иван Иванович"], ["💼", "Вакансия", "Начальник производства"]],
    stage: "Анализ резюме",
    quote: "Какой график работы предусмотрен на производстве?",
    status: "Не нашёл подходящего ответа в базе знаний.",
    action: "Ответьте reply или откройте карточку кандидата.",
    tag: "#Иванов_Иван_Иванович",
  }),
  buildCard({
    header: "🗄 НУЖЕН РУЧНОЙ ОТВЕТ",
    fields: [["👤", "Кандидат", "Михайлов Олег Ильич"], ["💼", "Вакансия", "Руководитель агентского канала продаж"]],
    stage: "Анализ анкеты",
    quote: "Добрый день! Подскажите, вакансия ещё актуальна?",
    status: "Не может ответить — вакансия находится в архиве HH.",
    action: "Откройте чат кандидата и ответьте вручную.",
  }),
  buildCard({
    header: "🗓 КАНДИДАТ ПРЕДЛОЖИЛ ВРЕМЯ",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"], ["🕐", "Распознанный слот", "25.08.2026 в 11:00"]],
    stage: "Собеседование",
    quote: "Мне будет удобно во вторник 25.08 в 11:00.",
    status: "Распознал точные дату и время.",
    action: "Ответьте reply: подтвердите время, предложите другое или задайте уточняющий вопрос.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "🗓 НУЖНО УТОЧНИТЬ ВРЕМЯ",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"]],
    stage: "Собеседование",
    quote: "Можно перенести на следующую неделю в первой половине дня?",
    status: "Не смог определить точные дату и время.",
    action: "Ответьте reply и предложите конкретный свободный слот.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "✅ СОБЕСЕДОВАНИЕ НАЗНАЧЕНО",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"], ["🗓", "Дата и время", "25.08.2026 в 11:00"]],
    stage: "Собеседование",
    status: "Записал встречу и завершил согласование времени.",
  }),
  buildCard({
    header: "⏰ НУЖНО РЕШЕНИЕ ПО ВСТРЕЧЕ",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"], ["🗓", "Дата и время", "25.08.2026 в 11:00"]],
    stage: "Собеседование",
    quoteLabel: "Сообщение, которое получит кандидат",
    quote: "Елена, здравствуйте! Напоминаем, что сегодня, 25 августа, ждём вас на собеседование в 11:00. Подтвердите, пожалуйста, что сможете подойти.",
    status: "Подготовил напоминание с точными датой и временем, но пока его не отправлял.",
    action: "Отправьте вопрос кандидату или отмените встречу кнопкой ниже.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "✅ КАНДИДАТ ПОДТВЕРДИЛ ВСТРЕЧУ",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"]],
    stage: "Собеседование",
    quoteLabel: "Ответ кандидата",
    quote: "Да, всё в силе",
    status: "Отметил встречу подтверждённой. Повторный запрос не отправится.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "♻️ КАНДИДАТ ПРОСИТ ПЕРЕНОС",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"]],
    stage: "Собеседование",
    quote: "Сегодня не смогу, можно завтра?",
    status: "Снял прежнюю бронь с календаря.",
    action: "Согласуйте с кандидатом новое точное время reply-сообщением.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "❓ ОТВЕТ НЕ УДАЛОСЬ ПОНЯТЬ",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"]],
    stage: "Собеседование",
    quoteLabel: "Ответ кандидата",
    quote: "Пока точно не знаю",
    status: "Не смог уверенно определить подтверждение или перенос.",
    action: "Проверьте сообщение и ответьте кандидату вручную.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "💬 НОВОЕ СООБЩЕНИЕ КАНДИДАТА",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"]],
    stage: "Собеседование",
    quote: "Спасибо Вам 🙂",
    status: "Не запускал повторное подтверждение встречи.",
    action: "При необходимости ответьте reply — ответ уйдёт кандидату в HH.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "♻️ ПЕРЕНОС НАЗНАЧЕННОЙ ВСТРЕЧИ",
    fields: [["👤", "Кандидат", "Богомолова Елена Юрьевна"], ["💼", "Вакансия", "Специалист по работе с волонтёрскими организациями/Менеджер по продажам"], ["🗓", "Было", "25.08.2026 в 11:00"], ["🗓", "Предложено", "26.08.2026 в 14:00"]],
    stage: "Собеседование",
    quote: "Не смогу приехать 25.08. Можно перенести на 26.08 в 14:00?",
    status: "Распознал перенос и снял прежнюю бронь.",
    action: "Ответьте reply: подтвердите новый слот или предложите другое время.",
    tag: "#Богомолова_Елена_Юрьевна",
  }),
  buildCard({
    header: "🗄 КАНДИДАТЫ АРХИВНОЙ ВАКАНСИИ",
    fields: [["💼", "Вакансия", "Руководитель агентского канала продаж"], ["👥", "Всего", "50 кандидатов"], ["📄", "Часть списка", "1 из 2"]],
    details: ["1. Макаров Андрей Александрович", "2. Байрамалиев Артур", "3. Клейменова Кристина Олеговна", "4. Глухова Анастасия Васильевна", "5. Миронова Юлия Сергеевна"],
    status: "Не может написать кандидатам через архивную вакансию.",
    action: "Свяжитесь с нужными кандидатами вручную в HH.",
  }),
  buildCard({
    header: "📊 СВОДКА ПО ВАКАНСИИ",
    fields: [["💼", "Вакансия", "Начальник производства"], ["👤", "Аккаунт HH", "hr@example.ru"], ["🕐", "Период", "11:00–12:00"]],
    details: ["НОВЫЕ ОТКЛИКИ", "👥 Всего: 12", "✅ Прошли: 5", "🤔 На проверку: 3", "❌ Отказ: 4", "", "РЕШЕНИЯ HR", "📋 Обработано: 2", "✅ Принято: 1", "❌ Отклонено: 1"],
  }),
  buildCard({
    header: "📭 НОВЫХ ОТКЛИКОВ НЕТ",
    fields: [["💼", "Вакансия", "Начальник производства"], ["👤", "Аккаунт HH", "hr@example.ru"], ["🕐", "Период", "12:00–13:00"]],
    status: "Проверил вакансию — новых откликов за период не найдено.",
  }),
  buildCard({
    header: "🎯 ВЫ НАЗНАЧЕНЫ ОТВЕТСТВЕННЫМ",
    fields: [["💼", "Вакансия", "Начальник производства"]],
    details: ["Теперь вы будете получать уведомления о назначенных собеседованиях по этой вакансии."],
    links: [["Открыть вакансию на HH", "https://hh.ru"]],
  }),
  buildCard({
    header: "📋 НАЗНАЧЕНО СОБЕСЕДОВАНИЕ",
    fields: [["💼", "Вакансия", "Начальник производства"], ["👤", "Кандидат", "Иванов Иван Иванович"], ["🗓", "Дата", "27.08.2026"], ["🕐", "Время", "15:30"], ["☎️", "Связь", "+7 900 000-00-00"]],
    stage: "Собеседование",
    links: [["Открыть тестовое резюме на HH", "https://hh.ru"]],
  }),
  buildCard({
    header: "⏰ СОБЕСЕДОВАНИЕ ЧЕРЕЗ 30 МИНУТ",
    fields: [["💼", "Вакансия", "Начальник производства"], ["👤", "Кандидат", "Иванов Иван Иванович"], ["🕐", "Время", "15:30"], ["☎️", "Связь", "+7 900 000-00-00"]],
    stage: "Собеседование",
  }),
  buildCard({
    header: "📅 РАСПИСАНИЕ СОБЕСЕДОВАНИЙ",
    fields: [["💼", "Вакансия", "Начальник производства"]],
    details: ["27.08.2026", "• 11:00 — Петрова Анна Сергеевна", "• 15:30 — Иванов Иван Иванович", "", "28.08.2026", "• 10:00 — Сидоров Павел Олегович"],
  }),
  buildCard({
    header: "📅 СОБЕСЕДОВАНИЙ ПОКА НЕТ",
    fields: [["💼", "Вакансия", "Начальник производства"]],
    status: "Проверил календарь — будущих встреч не найдено.",
  }),
  buildCard({
    header: "⏳ ОБРАБОТКА УЖЕ ИДЁТ",
    details: ["Предыдущий запуск ещё не завершён."],
    action: "Дождитесь завершения и попробуйте снова.",
  }),
  buildCard({
    header: "🚨 НЕ УДАЛОСЬ ВЫПОЛНИТЬ КОМАНДУ",
    status: "Произошла внутренняя ошибка. Данные и сообщения кандидатам не изменялись.",
    action: "Повторите попытку через несколько минут. Если ошибка останется — сообщите администратору.",
  }),
];

function renderScenario(scenario, design) {
  const index = scenarios.indexOf(scenario);
  return recommendedCards[index] || emphasizeLabels(scenario.text);
}

function scenarioKeyboard(scenario) {
  if (!scenario.buttons?.length) return undefined;
  return { inline_keyboard: [scenario.buttons.map(([text, callbackData]) => ({ text, callback_data: callbackData }))] };
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch { return {}; }
}

function saveSettings(settings) {
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

const settings = loadSettings();

function demoVacancyById(id) {
  return demoVacancies.find((vacancy) => vacancy.id === String(id || "")) || null;
}

function normalizeTopicText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function loadTopicsMap() {
  for (const filePath of topicsFileCandidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      console.warn(`Could not read topics map ${filePath}: ${error.message}`);
    }
  }
  return {};
}

function demoVacancyIdByTopicName(topicName) {
  const normalizedName = normalizeTopicText(topicName);
  const exact = demoVacancies.find((vacancy) => normalizeTopicText(vacancy.name) === normalizedName);
  if (exact) return exact.id;
  for (const vacancy of demoVacancies) {
    const aliases = vacancyTopicAliases[vacancy.id] || [];
    if (aliases.some((alias) => normalizedName.includes(normalizeTopicText(alias)))) return vacancy.id;
  }
  return null;
}

function vacancyIdByThread(threadId, topics = loadTopicsMap()) {
  const numericThreadId = Number(threadId);
  if (!Number.isInteger(numericThreadId) || numericThreadId <= 0) return null;
  for (const [topicName, mappedThreadId] of Object.entries(topics || {})) {
    if (Number(mappedThreadId) !== numericThreadId) continue;
    const vacancyId = demoVacancyIdByTopicName(topicName);
    if (vacancyId) return vacancyId;
  }
  return null;
}

function vacancySettingsKey(id) {
  return `vacancy:${id}`;
}

function getVacancySettings(id) {
  const vacancy = demoVacancyById(id);
  if (!vacancy) return null;
  const saved = settings[vacancySettingsKey(id)] || {};
  const savedWorkflow = legacyWorkflowAliases[saved.workflow] || saved.workflow;
  const workflow = Object.hasOwn(workflowLabels, savedWorkflow) ? savedWorkflow : vacancy.defaults.workflow;
  const minScoreRaw = Number(saved.minScore);
  const savedTemplates = saved.templates && typeof saved.templates === "object" ? saved.templates : {};
  return {
    active: typeof saved.active === "boolean" ? saved.active : vacancy.defaults.active,
    workflow,
    minScore: Number.isFinite(minScoreRaw) && minScoreRaw >= 0 && minScoreRaw <= 10
      ? minScoreRaw
      : vacancy.defaults.minScore,
    filters: (Array.isArray(saved.filters) ? saved.filters : vacancy.defaults.filters)
      .map(normalizeFilter)
      .filter((item) => item.text),
    templates: {
      resumeSuitable: String(savedTemplates.resumeSuitable || savedTemplates.suitable || vacancy.defaults.templates.resumeSuitable).trim(),
      resumeReject: String(savedTemplates.resumeReject || savedTemplates.reject || vacancy.defaults.templates.resumeReject).trim(),
      stageSuitable: String(savedTemplates.stageSuitable || vacancy.defaults.templates.stageSuitable).trim(),
      stageReject: String(savedTemplates.stageReject || vacancy.defaults.templates.stageReject).trim(),
    },
  };
}

function updateVacancySettings(id, patch) {
  const current = getVacancySettings(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  settings[vacancySettingsKey(id)] = next;
  saveSettings(settings);
  return next;
}

function demoCandidateDecisionKey(candidateId) {
  return `candidate-decision:${candidateId}`;
}

function pendingCandidatesForVacancy(vacancyId) {
  return demoCandidates.filter((candidate) => (
    candidate.vacancyId === vacancyId && !settings[demoCandidateDecisionKey(candidate.id)]
  ));
}

function candidateTaskLabel(task) {
  if (task === "questionnaire") return "Решение по анкете";
  if (task === "answer") return "Решение по ответу в HH";
  return "Ручная проверка резюме";
}

function candidateDecisionValue(task, decision) {
  if (decision === "accept") return "Подходит";
  return task === "resume" || task === "answer" ? "Отказ" : "Не подходит";
}

function contextKey(chatId, threadId = 0) {
  return `${chatId}:${threadId || 0}`;
}

function callbackButton(text, callback_data) {
  if (Buffer.byteLength(callback_data, "utf8") > 64) throw new Error(`Callback is too long: ${callback_data}`);
  return { text, callback_data };
}

function urlButton(text, url) {
  return { text, url };
}

function vacancyListView() {
  const lines = [
    "<b>⚙️ НАСТРОЙКИ ВАКАНСИЙ</b>",
    "",
    "Выберите вакансию, настройки которой хотите открыть.",
    "",
    "<i>🧪 Тестовый режим: рабочий бот, HH и Google-таблицы не изменяются.</i>",
  ];
  const rows = demoVacancies.map((vacancy) => {
    const current = getVacancySettings(vacancy.id);
    const icon = current?.active ? "🟢" : "⚪️";
    return [callbackButton(`${icon} ${vacancy.name}`.slice(0, 60), `cfg:open:${vacancy.id}`)];
  });
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

function vacancyMainView(id) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current) return vacancyListView();
  const pendingCandidates = pendingCandidatesForVacancy(id).length;
  const text = [
    "<b>⚙️ НАСТРОЙКИ</b>",
    "",
    `💼 <b>Вакансия:</b> ${escapeHtml(vacancy.name)}`,
    `${current.active ? "🟢 Активна" : "⏸ Приостановлена"}`,
    `🔄 ${workflowLabels[current.workflow]}`,
    `⭐️ От ${String(current.minScore).replace(".", ",")} баллов`,
    `🔎 Фильтров: ${current.filters.length}`,
  ].join("\n");
  return {
    text,
    keyboard: { inline_keyboard: [
      [callbackButton(`👥 Кандидаты — ждут решения: ${pendingCandidates}`, `cfg:candidates:${id}:0`)],
      [callbackButton("🔄 Сценарий обработки", `cfg:workflow:${id}`)],
      [callbackButton(current.active ? "⏸ Приостановить вакансию" : "▶️ Активировать вакансию", `cfg:activity:${id}`)],
      [callbackButton("⭐️ Проходной балл", `cfg:score:${id}`), callbackButton("🔎 Фильтры", `cfg:filters:${id}`)],
      [callbackButton("📝 Шаблоны сообщений", `cfg:templates:${id}`)],
      [callbackButton("⬅️ Все вакансии", "cfg:list")],
    ] },
  };
}

function workflowView(id) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current) return vacancyListView();
  const mark = (value) => current.workflow === value ? "✅ " : "";
  return {
    text: [
      "<b>🔄 РЕЖИМ ОБРАБОТКИ</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      "",
      "📋 <b>Анкета</b> — отправить ссылку после резюме.",
      "💬 <b>Вопрос в HH</b> — получить ответ кандидата в чате.",
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton(`${mark("questionnaire")}📋 Режим 1: анкета`, `cfg:setworkflow:${id}:questionnaire`)],
      [callbackButton(`${mark("chat_question")}💬 Режим 2: вопрос в HH`, `cfg:setworkflow:${id}:chat_question`)],
      [callbackButton("⬅️ Назад", `cfg:open:${id}`)],
    ] },
  };
}

function shortTemplate(text, limit = 750) {
  const value = String(text || "").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function workflowTemplateChoiceView(id, targetWorkflow) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current || !Object.hasOwn(workflowLabels, targetWorkflow)) return workflowView(id);
  return {
    text: [
      "<b>📝 ШАБЛОНЫ ДЛЯ НОВОГО РЕЖИМА</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      `🔄 ${workflowLabels[targetWorkflow]}`,
      "",
      "Оставить четыре текущих сообщения или настроить новые?",
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("✅ Оставить текущие шаблоны", `cfg:keepworkflow:${id}:${targetWorkflow}`)],
      [callbackButton("✏️ Ввести новые шаблоны", `cfg:newtemplates:${id}:${targetWorkflow}`)],
      [callbackButton("⬅️ Назад", `cfg:workflow:${id}`)],
    ] },
  };
}

function templatesView(id) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current) return vacancyListView();
  return {
    text: [
      "<b>📝 ШАБЛОНЫ СООБЩЕНИЙ</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      "",
      ...templateKeys.map((key, index) => `${index + 1}. ${escapeHtml(templateLabel(current.workflow, key))}`),
    ].join("\n"),
    keyboard: { inline_keyboard: [
      ...templateKeys.map((key, index) => [callbackButton(`${index + 1}. ${templateLabel(current.workflow, key)}`.slice(0, 60), `cfg:template:${id}:${key}`)]),
      [callbackButton("⬅️ Назад", `cfg:open:${id}`)],
    ] },
  };
}

function templateDetailView(id, key) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current || !templateKeys.includes(key)) return templatesView(id);
  return {
    text: [
      `<b>📝 ${escapeHtml(templateLabel(current.workflow, key)).toUpperCase()}</b>`,
      "",
      `<blockquote>${escapeHtml(shortTemplate(current.templates[key], 1800))}</blockquote>`,
      "",
      "<code>[Name]</code> · <code>[Vacancy]</code> · <code>[QuestionnaireLink]</code>",
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("✏️ Изменить", `cfg:edittemplate:${id}:${key}`)],
      [callbackButton("⬅️ К шаблонам", `cfg:templates:${id}`)],
    ] },
  };
}

function templateInputView(id, key, workflow, error = "") {
  const vacancy = demoVacancyById(id);
  if (!vacancy || !templateKeys.includes(key)) return vacancyListView();
  return {
    text: [
      "<b>✏️ ВВЕДИТЕ ТЕКСТ ШАБЛОНА</b>",
      "",
      `${escapeHtml(templateLabel(workflow, key))}`,
      "",
      error ? `⚠️ ${escapeHtml(error)}` : "Отправьте текст одним сообщением.",
      "",
      "<code>[Name]</code> · <code>[Vacancy]</code> · <code>[QuestionnaireLink]</code>",
    ].join("\n"),
    keyboard: { inline_keyboard: [[callbackButton("❌ Отменить ввод", `cfg:cancelinput:${id}`)]] },
  };
}

function templateConfirmView(id, targetWorkflow, draft) {
  const vacancy = demoVacancyById(id);
  if (!vacancy) return vacancyListView();
  return {
    text: [
      "<b>💾 СОХРАНИТЬ НОВЫЕ ШАБЛОНЫ?</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      `🔄 ${workflowLabels[targetWorkflow]}`,
      "",
      ...templateKeys.flatMap((key, index) => [
        `<b>${index + 1}. ${escapeHtml(templateLabel(targetWorkflow, key))}</b>`,
        `<blockquote>${escapeHtml(shortTemplate(draft[key], 420))}</blockquote>`,
      ]),
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("💾 Сохранить", `cfg:savetemplates:${id}`)],
      [callbackButton("❌ Отмена без сохранения", `cfg:cancelinput:${id}`)],
    ] },
  };
}

function scoreInputView(id, error = "") {
  const vacancy = demoVacancyById(id);
  if (!vacancy) return vacancyListView();
  return {
    text: [
      "<b>✏️ ВВЕДИТЕ ПРОХОДНОЙ БАЛЛ</b>",
      "",
      error ? `⚠️ ${escapeHtml(error)}` : "Отправьте число от 0 до 10, например 7,5.",
    ].join("\n"),
    keyboard: { inline_keyboard: [[callbackButton("❌ Отменить ввод", `cfg:cancelinput:${id}`)]] },
  };
}

function filterInputView(id, error = "", title = "НОВЫЙ ФИЛЬТР") {
  const vacancy = demoVacancyById(id);
  if (!vacancy) return vacancyListView();
  return {
    text: [
      `<b>➕ ${escapeHtml(title)}</b>`,
      "",
      error ? `⚠️ ${escapeHtml(error)}` : "Отправьте требование одним сообщением.",
    ].join("\n"),
    keyboard: { inline_keyboard: [[callbackButton("❌ Отменить ввод", `cfg:cancelinput:${id}`)]] },
  };
}

function filterScoringView(id, index, draftText = "") {
  const current = getVacancySettings(id);
  const filter = Number.isInteger(index) ? current?.filters?.[index] : null;
  const text = filter?.text || draftText;
  if (!current || !text) return filtersView(id);
  const suffix = Number.isInteger(index) ? `:${index}` : "";
  const prefix = Number.isInteger(index) ? "filter" : "newfilter";
  return {
    text: [
      "<b>⚖️ ВЕС ФИЛЬТРА</b>",
      "",
      `<blockquote>${escapeHtml(text)}</blockquote>`,
      "",
      "<b>Авто +</b> — наличие критерия повышает оценку.",
      "<b>Авто −</b> — наличие критерия снижает оценку.",
      "В авто-режиме размер изменения определяет ИИ.",
      "<b>Точный вес</b> — задать своё число.",
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("🤖 Авто +", `cfg:${prefix}auto:${id}${suffix}:plus`), callbackButton("🤖 Авто −", `cfg:${prefix}auto:${id}${suffix}:minus`)],
      [callbackButton("⚖️ Указать точный вес", `cfg:${prefix}fixed:${id}${suffix}`)],
      [callbackButton("⬅️ Назад", Number.isInteger(index) ? `cfg:filter:${id}:${index}` : `cfg:cancelinput:${id}`)],
    ] },
  };
}

function filterPointsInputView(id, text, error = "") {
  return {
    text: [
      "<b>⚖️ ТОЧНЫЙ ВЕС ФИЛЬТРА</b>",
      "",
      `<blockquote>${escapeHtml(text)}</blockquote>`,
      "",
      error ? `⚠️ ${escapeHtml(error)}` : "Отправьте число от −10 до +10, кроме нуля.",
      "Например: <code>+1,5</code> или <code>-2</code>.",
    ].join("\n"),
    keyboard: { inline_keyboard: [[callbackButton("❌ Отменить ввод", `cfg:cancelinput:${id}`)]] },
  };
}

function activityView(id) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current) return vacancyListView();
  return {
    text: [
      `<b>${current.active ? "⏸ ПРИОСТАНОВИТЬ" : "▶️ АКТИВИРОВАТЬ"} ВАКАНСИЮ?</b>`,
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton(current.active ? "⏸ Да, приостановить" : "▶️ Да, активировать", `cfg:setactive:${id}:${current.active ? 0 : 1}`)],
      [callbackButton("⬅️ Отмена", `cfg:open:${id}`)],
    ] },
  };
}

function scoreView(id) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current) return vacancyListView();
  const scoreButtons = [5, 6, 7, 8, 9].map((score) => callbackButton(
    `${current.minScore === score ? "✅ " : ""}${score}`,
    `cfg:setscore:${id}:${score}`,
  ));
  return {
    text: [
      "<b>⭐️ ПРОХОДНОЙ БАЛЛ</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      `Сейчас: <b>${String(current.minScore).replace(".", ",")} из 10</b>`,
    ].join("\n"),
    keyboard: { inline_keyboard: [
      scoreButtons.slice(0, 3),
      scoreButtons.slice(3),
      [callbackButton("✏️ Ввести другой балл", `cfg:customscore:${id}`)],
      [callbackButton("⬅️ Назад", `cfg:open:${id}`)],
    ] },
  };
}

const FILTERS_PER_PAGE = 5;

function filtersView(id, requestedPage = 0) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  if (!vacancy || !current) return vacancyListView();
  const pageCount = Math.max(1, Math.ceil(current.filters.length / FILTERS_PER_PAGE));
  const page = Math.max(0, Math.min(Number(requestedPage) || 0, pageCount - 1));
  const start = page * FILTERS_PER_PAGE;
  const visible = current.filters.slice(start, start + FILTERS_PER_PAGE);
  const list = visible.length
    ? visible.map((item, offset) => `<b>${start + offset + 1}. [${escapeHtml(filterWeightLabel(item))}]</b> ${escapeHtml(shortTemplate(item.text, 220))}`)
    : ["Фильтров пока нет."];
  const keyboard = visible.map((item, offset) => [callbackButton(
    `${start + offset + 1}. [${filterWeightLabel(item)}] ${item.text}`.slice(0, 60),
    `cfg:filter:${id}:${start + offset}`,
  )]);
  if (pageCount > 1) {
    const navigation = [];
    if (page > 0) navigation.push(callbackButton("⬅️", `cfg:filters:${id}:${page - 1}`));
    navigation.push(callbackButton(`${page + 1} / ${pageCount}`, `cfg:filters:${id}:${page}`));
    if (page < pageCount - 1) navigation.push(callbackButton("➡️", `cfg:filters:${id}:${page + 1}`));
    keyboard.push(navigation);
  }
  keyboard.push([callbackButton("➕ Добавить фильтр", `cfg:addfilter:${id}:${page}`)]);
  keyboard.push([callbackButton("⬅️ Назад", `cfg:open:${id}`)]);
  return {
    text: [
      "<b>🔎 ДОПОЛНИТЕЛЬНЫЕ ФИЛЬТРЫ</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      current.filters.length ? `Страница ${page + 1} из ${pageCount}` : "",
      "",
      ...list,
    ].join("\n"),
    keyboard: { inline_keyboard: keyboard },
  };
}

function filterDetailView(id, index) {
  const current = getVacancySettings(id);
  const filter = current?.filters?.[index];
  if (!current || !filter) return filtersView(id);
  return {
    text: [
      `<b>🔎 ФИЛЬТР №${index + 1}</b>`,
      "",
      `<blockquote>${escapeHtml(filter.text)}</blockquote>`,
      "",
      `⚖️ Вес: <b>${escapeHtml(filterWeightLabel(filter))}</b>`,
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("⚖️ Изменить вес", `cfg:filterweight:${id}:${index}`)],
      [callbackButton("✏️ Изменить текст", `cfg:editfilter:${id}:${index}`)],
      [callbackButton("🗑 Удалить", `cfg:askdel:${id}:${index}`)],
      [callbackButton("⬅️ К фильтрам", `cfg:filters:${id}:${Math.floor(index / FILTERS_PER_PAGE)}`)],
    ] },
  };
}

function deleteFilterView(id, index) {
  const vacancy = demoVacancyById(id);
  const current = getVacancySettings(id);
  const filter = current?.filters?.[index];
  if (!vacancy || !current || !filter) return filtersView(id);
  return {
    text: [
      "<b>🗑 УДАЛИТЬ ФИЛЬТР?</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      "",
      `<blockquote>${escapeHtml(filter.text)}</blockquote>`,
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("🗑 Да, удалить", `cfg:delfilter:${id}:${index}`)],
      [callbackButton("⬅️ Отмена", `cfg:filter:${id}:${index}`)],
    ] },
  };
}

function candidateCardView(id, requestedIndex = 0) {
  const vacancy = demoVacancyById(id);
  const candidates = pendingCandidatesForVacancy(id);
  if (!vacancy) return vacancyListView();
  if (!candidates.length) return noCandidatesView(id);
  const index = Math.max(0, Math.min(Number(requestedIndex) || 0, candidates.length - 1));
  const candidate = candidates[index];
  const detailLabel = candidate.task === "questionnaire" ? "Ответы анкеты" : "Ответ кандидата";
  const lines = [
    `<b>👥 КАНДИДАТ ${index + 1} ИЗ ${candidates.length}</b>`,
    "",
    `👤 <b>${escapeHtml(candidate.name)}</b>`,
    `💼 ${escapeHtml(vacancy.name)}`,
    `📍 ${candidateTaskLabel(candidate.task)}`,
    `⭐️ Балл: <b>${String(candidate.score).replace(".", ",")}</b>`,
    `🗓 ${escapeHtml(candidate.date)}`,
    "",
    "<b>Заключение ИИ</b>",
    `<blockquote>${escapeHtml(candidate.summary)}</blockquote>`,
  ];
  if (candidate.candidateText) {
    lines.push("", `<b>${detailLabel}</b>`, `<blockquote>${escapeHtml(candidate.candidateText)}</blockquote>`);
  }
  lines.push("", "<i>🧪 Решение сохранится только в тестовом боте.</i>");

  const keyboard = [
    [
      callbackButton("✅ Подходит", `cfg:canddecision:${id}:${candidate.id}:accept:${index}`),
      callbackButton("❌ Не подходит", `cfg:canddecision:${id}:${candidate.id}:reject:${index}`),
    ],
  ];
  if (candidates.length > 1) {
    const navigation = [];
    if (index > 0) navigation.push(callbackButton("⬅️", `cfg:candidates:${id}:${index - 1}`));
    navigation.push(callbackButton(`${index + 1} / ${candidates.length}`, `cfg:candidates:${id}:${index}`));
    if (index < candidates.length - 1) navigation.push(callbackButton("➡️", `cfg:candidates:${id}:${index + 1}`));
    keyboard.push(navigation);
  }
  if (candidate.resumeUrl) keyboard.push([urlButton("🔗 Резюме кандидата", candidate.resumeUrl)]);
  keyboard.push([callbackButton("⬅️ К настройкам", `cfg:open:${id}`)]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: keyboard } };
}

function candidateDecisionConfirmView(id, candidateId, decision, returnIndex = 0) {
  const vacancy = demoVacancyById(id);
  const candidate = demoCandidates.find((item) => item.id === candidateId && item.vacancyId === id);
  if (!vacancy || !candidate) return candidateCardView(id, returnIndex);
  const value = candidateDecisionValue(candidate.task, decision);
  return {
    text: [
      "<b>ПОДТВЕРДИТЬ РЕШЕНИЕ?</b>",
      "",
      `👤 ${escapeHtml(candidate.name)}`,
      `📍 ${candidateTaskLabel(candidate.task)}`,
      `Решение: <b>${escapeHtml(value)}</b>`,
      "",
      "<i>🧪 В тесте Google-таблица и HH не изменяются.</i>",
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton(`✅ Да, ${value}`, `cfg:candconfirm:${id}:${candidate.id}:${decision}:${returnIndex}`)],
      [callbackButton("⬅️ Отмена", `cfg:candidates:${id}:${returnIndex}`)],
    ] },
  };
}

function noCandidatesView(id) {
  const vacancy = demoVacancyById(id);
  if (!vacancy) return vacancyListView();
  return {
    text: [
      "<b>✅ РЕШЕНИЙ НЕ ТРЕБУЕТСЯ</b>",
      "",
      `💼 ${escapeHtml(vacancy.name)}`,
      "Все демонстрационные карточки обработаны.",
    ].join("\n"),
    keyboard: { inline_keyboard: [
      [callbackButton("♻️ Вернуть демо-карточки", `cfg:candreset:${id}`)],
      [callbackButton("⬅️ К настройкам", `cfg:open:${id}`)],
    ] },
  };
}

const settingsCallbackActions = new Set([
  "list", "open", "candidates", "canddecision", "candconfirm", "candreset",
  "workflow", "setworkflow", "keepworkflow", "templates", "template", "edittemplate",
  "newtemplates", "savetemplates", "activity", "setactive", "score", "setscore",
  "customscore", "filters", "filter", "filterweight", "editfilter", "addfilter",
  "filterauto", "filterfixed", "newfilterauto", "newfilterfixed", "askdel", "delfilter",
  "cancelinput",
]);

function validateTelegramHtml(text) {
  const stack = [];
  const tags = /<(\/)?(b|strong|i|em|u|ins|s|strike|del|a|code|pre|blockquote)(?:\s[^>]*)?>/gi;
  for (const match of String(text || "").matchAll(tags)) {
    const closing = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) throw new Error(`Unbalanced Telegram HTML tag: ${tag}`);
  }
  if (stack.length) throw new Error(`Unclosed Telegram HTML tag: ${stack.at(-1)}`);
}

function validateSettingsViews() {
  const views = [vacancyListView()];
  for (const vacancy of demoVacancies) {
    const candidateSettingBackup = new Map();
    for (const candidate of demoCandidates.filter((item) => item.vacancyId === vacancy.id)) {
      const decisionKey = demoCandidateDecisionKey(candidate.id);
      candidateSettingBackup.set(decisionKey, settings[decisionKey]);
      delete settings[decisionKey];
    }
    const sampleDraft = {
      resumeSuitable: "Здравствуйте, [Name]! Пройдите следующий этап.",
      resumeReject: "Здравствуйте, [Name]! По резюме получен отказ.",
      stageSuitable: "Здравствуйте, [Name]! Приглашаем на собеседование.",
      stageReject: "Здравствуйте, [Name]! По итогам этапа получен отказ.",
    };
    views.push(
      vacancyMainView(vacancy.id),
      workflowView(vacancy.id),
      workflowTemplateChoiceView(vacancy.id, "questionnaire"),
      workflowTemplateChoiceView(vacancy.id, "chat_question"),
      templatesView(vacancy.id),
      ...templateKeys.flatMap((key) => [
        templateDetailView(vacancy.id, key),
        templateInputView(vacancy.id, key, "questionnaire"),
        templateInputView(vacancy.id, key, "chat_question"),
      ]),
      templateConfirmView(vacancy.id, "questionnaire", sampleDraft),
      templateConfirmView(vacancy.id, "chat_question", sampleDraft),
      activityView(vacancy.id),
      scoreView(vacancy.id),
      scoreInputView(vacancy.id),
      filtersView(vacancy.id),
      filterInputView(vacancy.id),
      filterDetailView(vacancy.id, 0),
      filterScoringView(vacancy.id, 0),
      filterScoringView(vacancy.id, null, "Тестовый новый фильтр"),
      filterPointsInputView(vacancy.id, "Тестовый фильтр"),
      deleteFilterView(vacancy.id, 0),
      candidateCardView(vacancy.id, 0),
      noCandidatesView(vacancy.id),
    );
    const sampleCandidate = demoCandidates.find((candidate) => candidate.vacancyId === vacancy.id);
    if (sampleCandidate) {
      views.push(
        candidateDecisionConfirmView(vacancy.id, sampleCandidate.id, "accept", 0),
        candidateDecisionConfirmView(vacancy.id, sampleCandidate.id, "reject", 0),
      );
    }
    for (const [decisionKey, previous] of candidateSettingBackup) {
      if (previous === undefined) delete settings[decisionKey];
      else settings[decisionKey] = previous;
    }

    const storageKey = vacancySettingsKey(vacancy.id);
    const previousVacancySettings = settings[storageKey];
    const current = getVacancySettings(vacancy.id);
    settings[storageKey] = {
      ...current,
      filters: Array.from({ length: 12 }, (_, index) => ({
        text: `Тестовый фильтр №${index + 1}`,
        scoring: index % 2 === 0
          ? { mode: "auto", direction: "plus" }
          : { mode: "fixed", points: -1 },
      })),
    };
    const filterPages = [filtersView(vacancy.id, 0), filtersView(vacancy.id, 1), filtersView(vacancy.id, 2)];
    for (const pageView of filterPages) {
      const visibleFilterButtons = pageView.keyboard.inline_keyboard
        .flat()
        .filter((button) => String(button.callback_data || "").startsWith(`cfg:filter:${vacancy.id}:`));
      if (visibleFilterButtons.length > FILTERS_PER_PAGE) throw new Error("Too many filters on one page");
    }
    views.push(...filterPages, filterDetailView(vacancy.id, 11));
    if (previousVacancySettings === undefined) delete settings[storageKey];
    else settings[storageKey] = previousVacancySettings;
  }
  for (const view of views) {
    if (!view?.text || view.text.length > 4096) throw new Error("Invalid settings view");
    validateTelegramHtml(view.text);
    let buttonCount = 0;
    for (const row of view.keyboard?.inline_keyboard || []) {
      if (!row.length || row.length > 8) throw new Error("Invalid Telegram keyboard row");
      buttonCount += row.length;
      for (const button of row) {
        if (button.callback_data) {
          callbackButton(button.text, button.callback_data);
          const [prefix, action] = String(button.callback_data).split(":");
          if (prefix === "cfg" && !settingsCallbackActions.has(action)) throw new Error(`Unhandled settings callback: ${action}`);
        }
        else if (!button.url) throw new Error("Invalid settings button");
      }
    }
    if (buttonCount > 100) throw new Error("Too many Telegram keyboard buttons");
  }
}

function validateSettingsMigration() {
  const vacancy = demoVacancies[0];
  const storageKey = vacancySettingsKey(vacancy.id);
  const previous = settings[storageKey];
  settings[storageKey] = {
    workflow: "resume_questionnaire",
    minScore: "7.5",
    filters: ["Старый строковый фильтр"],
    templates: { suitable: "Старый подходит", reject: "Старый отказ" },
  };
  const migrated = getVacancySettings(vacancy.id);
  if (
    migrated.workflow !== "questionnaire"
    || migrated.minScore !== 7.5
    || migrated.filters[0]?.text !== "Старый строковый фильтр"
    || migrated.filters[0]?.scoring?.mode !== "auto"
    || migrated.templates.resumeSuitable !== "Старый подходит"
    || migrated.templates.resumeReject !== "Старый отказ"
    || !migrated.templates.stageSuitable
    || !migrated.templates.stageReject
  ) throw new Error("Legacy settings migration failed");
  if (previous === undefined) delete settings[storageKey];
  else settings[storageKey] = previous;
}

function readOwner() {
  try { return fs.readFileSync(ownerFile, "utf8").trim() || null; } catch { return null; }
}

function selfTest() {
  for (const [index, scenario] of scenarios.entries()) {
    if (!scenario.name || !scenario.text) throw new Error(`Invalid scenario ${index + 1}`);
    for (const design of Object.keys(designs)) {
      const rendered = renderScenario(scenario, design);
      if (rendered.length > 4096) throw new Error(`Message too long: ${index + 1}/${design}`);
      validateTelegramHtml(rendered);
    }
  }
  const syntheticTopics = Object.fromEntries(demoVacancies.map((vacancy, index) => [vacancy.name, 1000 + index]));
  for (const [index, vacancy] of demoVacancies.entries()) {
    if (vacancyIdByThread(1000 + index, syntheticTopics) !== vacancy.id) {
      throw new Error(`Topic routing failed for ${vacancy.id}`);
    }
  }
  if (vacancyIdByThread(9999, syntheticTopics) !== null || vacancyIdByThread(null, syntheticTopics) !== null) {
    throw new Error("Unknown topic must open the vacancy list");
  }
  const duplicateTopicNames = {
    "???????? ?????": 777,
    "Начальник производства / Руководитель цеха металлообработки": 777,
  };
  if (vacancyIdByThread(777, duplicateTopicNames) !== "production") {
    throw new Error("Topic routing must skip a broken duplicate name");
  }
  const configuredTopics = loadTopicsMap();
  for (const [topicName, threadId] of Object.entries(configuredTopics)) {
    const expectedVacancyId = demoVacancyIdByTopicName(topicName);
    if (expectedVacancyId && vacancyIdByThread(threadId, configuredTopics) !== expectedVacancyId) {
      throw new Error(`Configured topic routing failed for ${topicName}`);
    }
  }
  validateSettingsMigration();
  validateSettingsViews();
  console.log(`Self-test passed: ${scenarios.length} production-like scenarios, ${Object.keys(designs).length} designs.`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const token = env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN is missing in .env");
const apiBase = `https://api.telegram.org/bot${token}`;
let ownerChatId = readOwner();
const sentScenarioByMessage = new Map();
const pendingSettingsInput = new Map();
let stopping = false;

function getDesign(chatId) {
  return "recommended";
}

function getCursor(chatId) {
  return Number(settings[`cursor:${chatId}`] || 0) % scenarios.length;
}

async function telegram(method, payload = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: ${result.description || response.statusText}`);
  return result.result;
}

async function sendMessage(chatId, text, replyMarkup, options = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(options.messageThreadId ? { message_thread_id: options.messageThreadId } : {}),
  });
}

async function editMessage(chatId, messageId, view) {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: view.text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: view.keyboard,
    });
  } catch (error) {
    if (!String(error.message || "").includes("message is not modified")) throw error;
    return null;
  }
}

async function sendSettingsView(message, view) {
  return sendMessage(message.chat.id, view.text, view.keyboard, { messageThreadId: message.message_thread_id });
}

async function deleteInputMessage(message) {
  try {
    await telegram("deleteMessage", { chat_id: message.chat.id, message_id: message.message_id });
  } catch (error) {
    console.warn(`Could not delete settings input ${message.message_id}: ${error.message}`);
  }
}

function pendingCancelView(pending) {
  if (pending.returnTo === "filters") return filtersView(pending.vacancyId, pending.page || 0);
  if (pending.returnTo === "templates") return templatesView(pending.vacancyId);
  if (pending.returnTo === "workflow") return workflowView(pending.vacancyId);
  if (pending.returnTo === "filterDetail") return filterDetailView(pending.vacancyId, pending.filterIndex);
  if (pending.returnTo === "templateDetail") return templateDetailView(pending.vacancyId, pending.templateKey);
  return vacancyMainView(pending.vacancyId);
}

function claimOrCheckOwner(chat, mayClaim = false) {
  const chatId = String(chat.id);
  if (!ownerChatId && mayClaim && chat.type === "private") {
    fs.writeFileSync(ownerFile, `${chatId}\n`, { mode: 0o600 });
    ownerChatId = chatId;
    console.log("Owner chat has been registered.");
  }
  return ownerChatId === chatId;
}

async function sendScenario(chatId, index, design = getDesign(chatId)) {
  const scenario = scenarios[index];
  const sent = await sendMessage(chatId, renderScenario(scenario, design), scenarioKeyboard(scenario));
  sentScenarioByMessage.set(`${chatId}:${sent.message_id}`, index);
}

async function sendWelcome(chatId) {
  await sendMessage(chatId, `<b>🧪 Тест нового оформления HR-бота</b>

Здесь воспроизводятся реальные виды сообщений исходного бота. HH, Google-таблицы, календарь и рабочая база отключены.

/next — следующее сообщение
/all — показать все случаи
/list — список случаев
/show 8 — показать один случай
/settings — тестовое меню настройки вакансий

Дизайн теперь единый. Кнопки появляются только там, где от HR требуется реальное действие.`);
}

async function handleReply(message) {
  const replyId = message.reply_to_message?.message_id;
  if (!replyId) return false;
  const scenarioIndex = sentScenarioByMessage.get(`${message.chat.id}:${replyId}`);
  if (scenarioIndex === undefined) return false;
  const kind = scenarios[scenarioIndex].replyKind;
  if (kind === "interview") {
    await sendMessage(message.chat.id, "Кандидату отправлено новое предложенное время. Жду его подтверждения в HH.\n\n<i>🧪 ДЕМО: в HH ничего не отправлено.</i>");
  } else if (kind === "candidate") {
    await sendMessage(message.chat.id, "Ответ отправлен кандидату в HH.\n\n<i>🧪 ДЕМО: в HH ничего не отправлено.</i>");
  } else {
    await sendMessage(message.chat.id, "<i>🧪 Это тестовое сообщение. В рабочие системы ничего не отправлено.</i>");
  }
  return true;
}

async function handlePendingSettingsInput(message, text) {
  const key = contextKey(message.chat.id, message.message_thread_id);
  const pending = pendingSettingsInput.get(key);
  if (!pending) return false;

  if (text.startsWith("/cancel") || text.startsWith("/settings") || text.startsWith("/setting") || text.startsWith("/seting")) {
    pendingSettingsInput.delete(key);
    await deleteInputMessage(message);
    await editMessage(message.chat.id, pending.menuMessageId, pendingCancelView(pending));
    return true;
  }

  await deleteInputMessage(message);

  if (pending.type === "score") {
    const value = Number(text.replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      await editMessage(message.chat.id, pending.menuMessageId, scoreInputView(pending.vacancyId, "Нужно число от 0 до 10, например 7 или 7,5."));
      return true;
    }
    const rounded = Math.round(value * 10) / 10;
    updateVacancySettings(pending.vacancyId, { minScore: rounded });
    pendingSettingsInput.delete(key);
    await editMessage(message.chat.id, pending.menuMessageId, vacancyMainView(pending.vacancyId));
    return true;
  }

  if (pending.type === "filter_text_new" || pending.type === "filter_text_edit") {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value || value.length > 500) {
      await editMessage(message.chat.id, pending.menuMessageId, filterInputView(
        pending.vacancyId,
        "Нужно от 1 до 500 символов.",
        pending.type === "filter_text_edit" ? "ИЗМЕНИТЬ ФИЛЬТР" : "НОВЫЙ ФИЛЬТР",
      ));
      return true;
    }
    const current = getVacancySettings(pending.vacancyId);
    const duplicate = current.filters.some((item, index) => (
      index !== pending.filterIndex && item.text.toLowerCase() === value.toLowerCase()
    ));
    if (duplicate) {
      await editMessage(message.chat.id, pending.menuMessageId, filterInputView(
        pending.vacancyId,
        "Такой фильтр уже есть.",
        pending.type === "filter_text_edit" ? "ИЗМЕНИТЬ ФИЛЬТР" : "НОВЫЙ ФИЛЬТР",
      ));
      return true;
    }
    if (pending.type === "filter_text_edit") {
      const filters = current.filters.map((item, index) => index === pending.filterIndex ? { ...item, text: value } : item);
      updateVacancySettings(pending.vacancyId, { filters });
      pendingSettingsInput.delete(key);
      await editMessage(message.chat.id, pending.menuMessageId, filterDetailView(pending.vacancyId, pending.filterIndex));
      return true;
    }
    pending.type = "filter_new_scoring";
    pending.draftText = value;
    pendingSettingsInput.set(key, pending);
    await editMessage(message.chat.id, pending.menuMessageId, filterScoringView(pending.vacancyId, null, value));
    return true;
  }

  if (pending.type === "filter_points_new" || pending.type === "filter_points_edit") {
    const normalizedNumber = text.replace(",", ".").replace("−", "-").trim();
    const value = Number(normalizedNumber);
    if (!Number.isFinite(value) || value === 0 || value < -10 || value > 10) {
      const filterText = pending.type === "filter_points_new"
        ? pending.draftText
        : getVacancySettings(pending.vacancyId)?.filters?.[pending.filterIndex]?.text;
      await editMessage(message.chat.id, pending.menuMessageId, filterPointsInputView(
        pending.vacancyId,
        filterText || "Фильтр",
        "Нужно число от −10 до +10, кроме нуля.",
      ));
      return true;
    }
    const points = Math.round(value * 10) / 10;
    const current = getVacancySettings(pending.vacancyId);
    if (pending.type === "filter_points_new") {
      updateVacancySettings(pending.vacancyId, {
        filters: [...current.filters, { text: pending.draftText, scoring: { mode: "fixed", points } }],
      });
      pendingSettingsInput.delete(key);
      const lastPage = Math.floor(current.filters.length / FILTERS_PER_PAGE);
      await editMessage(message.chat.id, pending.menuMessageId, filtersView(pending.vacancyId, lastPage));
      return true;
    }
    const filters = current.filters.map((item, index) => (
      index === pending.filterIndex ? { ...item, scoring: { mode: "fixed", points } } : item
    ));
    updateVacancySettings(pending.vacancyId, { filters });
    pendingSettingsInput.delete(key);
    await editMessage(message.chat.id, pending.menuMessageId, filterDetailView(pending.vacancyId, pending.filterIndex));
    return true;
  }

  if (pending.type === "template_value") {
    const value = String(message.text || "").trim();
    if (!value || value.length > 3000) {
      const templateKey = pending.keys[pending.position];
      await editMessage(message.chat.id, pending.menuMessageId, templateInputView(
        pending.vacancyId,
        templateKey,
        pending.targetWorkflow,
        "Шаблон должен содержать от 1 до 3000 символов.",
      ));
      return true;
    }
    const templateKey = pending.keys[pending.position];
    pending.draft = { ...pending.draft, [templateKey]: value };
    if (pending.position < pending.keys.length - 1) {
      pending.position += 1;
      pendingSettingsInput.set(key, pending);
      await editMessage(message.chat.id, pending.menuMessageId, templateInputView(
        pending.vacancyId,
        pending.keys[pending.position],
        pending.targetWorkflow,
      ));
      return true;
    }
    pending.type = "template_confirm";
    pendingSettingsInput.set(key, pending);
    await editMessage(
      message.chat.id,
      pending.menuMessageId,
      templateConfirmView(pending.vacancyId, pending.targetWorkflow, pending.draft),
    );
    return true;
  }

  if (pending.type === "filter_new_scoring") {
    await editMessage(message.chat.id, pending.menuMessageId, filterScoringView(pending.vacancyId, null, pending.draftText));
    return true;
  }

  if (pending.type === "template_confirm") {
    await editMessage(message.chat.id, pending.menuMessageId, templateConfirmView(
      pending.vacancyId,
      pending.targetWorkflow,
      pending.draft,
    ));
  } else {
    await editMessage(message.chat.id, pending.menuMessageId, pendingCancelView(pending));
  }
  return true;
}

async function handleMessage(message) {
  const text = String(message.text || "").trim();
  const isStart = text.startsWith("/start");
  if (!claimOrCheckOwner(message.chat, isStart)) {
    await sendMessage(message.chat.id, ownerChatId ? "Этот тестовый бот уже закреплён за владельцем." : "Нажмите Start или отправьте /start.");
    return;
  }
  if (await handlePendingSettingsInput(message, text)) return;
  if (await handleReply(message)) return;
  if (isStart || text.startsWith("/help")) return sendWelcome(message.chat.id);

  if (text.startsWith("/settings") || text.startsWith("/setting") || text.startsWith("/seting")) {
    const contextualVacancyId = vacancyIdByThread(message.message_thread_id);
    await sendSettingsView(message, contextualVacancyId ? vacancyMainView(contextualVacancyId) : vacancyListView());
    return;
  }

  if (text.startsWith("/next")) {
    const index = getCursor(message.chat.id);
    await sendScenario(message.chat.id, index);
    settings[`cursor:${message.chat.id}`] = (index + 1) % scenarios.length;
    saveSettings(settings);
    return;
  }
  if (text.startsWith("/all")) {
    await sendMessage(message.chat.id, `<b>Отправляю ${scenarios.length} типов сообщений в новом оформлении.</b>`);
    for (let index = 0; index < scenarios.length; index += 1) {
      await sendScenario(message.chat.id, index);
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    return;
  }
  if (text.startsWith("/list")) {
    const lines = scenarios.map((scenario, index) => `${index + 1}. ${escapeHtml(scenario.name)}`);
    await sendMessage(message.chat.id, `<b>Все тестовые случаи</b>\n\n${lines.join("\n")}\n\nПоказать один: <code>/show 8</code>`);
    return;
  }
  if (text.startsWith("/show")) {
    const number = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(number) || number < 1 || number > scenarios.length) {
      await sendMessage(message.chat.id, `Укажите номер от 1 до ${scenarios.length}, например <code>/show 8</code>.`);
      return;
    }
    await sendScenario(message.chat.id, number - 1);
    return;
  }
  if (text.startsWith("/design")) {
    await sendMessage(message.chat.id, "Дизайн теперь единый — выбирать вариант больше не нужно. Используйте /next или /all.");
    return;
  }
  await sendMessage(message.chat.id, "Используйте /next для следующего сообщения или /help для инструкции.");
}

async function handleCallback(query) {
  const message = query.message;
  if (!message || !claimOrCheckOwner(message.chat)) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Доступ закрыт", show_alert: true });
    return;
  }
  const data = String(query.data || "");
  if (data.startsWith("cfg:")) {
    const parts = data.split(":");
    const action = parts[1];
    const vacancyId = parts[2] || "";
    const messageId = message.message_id;
    const threadId = message.message_thread_id;
    const key = contextKey(message.chat.id, threadId);
    let view = null;
    let notice = "Готово";

    try {
      if (action === "list") {
        view = vacancyListView();
        notice = "Выберите вакансию";
      } else if (action === "open") {
        view = vacancyMainView(vacancyId);
        notice = "Настройки открыты";
      } else if (action === "candidates") {
        view = candidateCardView(vacancyId, Number(parts[3]));
        notice = "Кандидаты";
      } else if (action === "canddecision") {
        const candidateId = parts[3];
        const decision = parts[4];
        if (decision !== "accept" && decision !== "reject") throw new Error("Неизвестное решение");
        view = candidateDecisionConfirmView(vacancyId, candidateId, decision, Number(parts[5]));
        notice = "Подтвердите решение";
      } else if (action === "candconfirm") {
        const candidateId = parts[3];
        const decision = parts[4];
        const returnIndex = Number(parts[5]) || 0;
        const candidate = demoCandidates.find((item) => item.id === candidateId && item.vacancyId === vacancyId);
        if (!candidate || (decision !== "accept" && decision !== "reject")) throw new Error("Карточка не найдена");
        settings[demoCandidateDecisionKey(candidateId)] = {
          decision: candidateDecisionValue(candidate.task, decision),
          decidedAt: new Date().toISOString(),
        };
        saveSettings(settings);
        view = candidateCardView(vacancyId, returnIndex);
        notice = `Демо: ${candidateDecisionValue(candidate.task, decision)}`;
      } else if (action === "candreset") {
        for (const candidate of demoCandidates.filter((item) => item.vacancyId === vacancyId)) {
          delete settings[demoCandidateDecisionKey(candidate.id)];
        }
        saveSettings(settings);
        view = candidateCardView(vacancyId, 0);
        notice = "Демо-карточки возвращены";
      } else if (action === "workflow") {
        view = workflowView(vacancyId);
        notice = "Выберите сценарий";
      } else if (action === "setworkflow") {
        const workflow = parts[3];
        if (!Object.hasOwn(workflowLabels, workflow)) throw new Error("Неизвестный сценарий");
        const current = getVacancySettings(vacancyId);
        if (current.workflow === workflow) {
          view = workflowView(vacancyId);
          notice = "Этот режим уже выбран";
        } else {
          view = workflowTemplateChoiceView(vacancyId, workflow);
          notice = "Выберите, что сделать с шаблонами";
        }
      } else if (action === "keepworkflow") {
        const workflow = parts[3];
        if (!Object.hasOwn(workflowLabels, workflow)) throw new Error("Неизвестный сценарий");
        updateVacancySettings(vacancyId, { workflow });
        view = vacancyMainView(vacancyId);
        notice = "Режим изменён, шаблоны сохранены";
      } else if (action === "templates") {
        view = templatesView(vacancyId);
        notice = "Шаблоны";
      } else if (action === "template") {
        view = templateDetailView(vacancyId, parts[3]);
        notice = "Шаблон открыт";
      } else if (action === "edittemplate") {
        const templateKey = parts[3];
        if (!templateKeys.includes(templateKey)) throw new Error("Неизвестный шаблон");
        const current = getVacancySettings(vacancyId);
        pendingSettingsInput.set(key, {
          type: "template_value",
          vacancyId,
          targetWorkflow: current.workflow,
          keys: [templateKey],
          position: 0,
          draft: { ...current.templates },
          templateKey,
          menuMessageId: messageId,
          returnTo: "templateDetail",
          saveReturn: "templateDetail",
        });
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Введите новый текст" });
        await editMessage(message.chat.id, messageId, templateInputView(vacancyId, templateKey, current.workflow));
        return;
      } else if (action === "newtemplates") {
        const targetWorkflow = parts[3];
        if (!Object.hasOwn(workflowLabels, targetWorkflow)) throw new Error("Неизвестный сценарий");
        const current = getVacancySettings(vacancyId);
        pendingSettingsInput.set(key, {
          type: "template_value",
          vacancyId,
          targetWorkflow,
          keys: [...templateKeys],
          position: 0,
          draft: { ...current.templates },
          menuMessageId: messageId,
          returnTo: current.workflow === targetWorkflow ? "templates" : "workflow",
          saveReturn: "main",
        });
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Введите первый шаблон" });
        await editMessage(message.chat.id, messageId, templateInputView(vacancyId, templateKeys[0], targetWorkflow));
        return;
      } else if (action === "savetemplates") {
        const pending = pendingSettingsInput.get(key);
        if (!pending || pending.type !== "template_confirm" || pending.vacancyId !== vacancyId) {
          throw new Error("Черновик шаблонов не найден");
        }
        updateVacancySettings(vacancyId, {
          workflow: pending.targetWorkflow,
          templates: { ...pending.draft },
        });
        pendingSettingsInput.delete(key);
        view = pending.saveReturn === "templateDetail"
          ? templateDetailView(vacancyId, pending.templateKey)
          : vacancyMainView(vacancyId);
        notice = "Шаблоны сохранены";
      } else if (action === "activity") {
        view = activityView(vacancyId);
        notice = "Нужно подтверждение";
      } else if (action === "setactive") {
        updateVacancySettings(vacancyId, { active: parts[3] === "1" });
        view = vacancyMainView(vacancyId);
        notice = parts[3] === "1" ? "Вакансия активирована (демо)" : "Вакансия приостановлена (демо)";
      } else if (action === "score") {
        view = scoreView(vacancyId);
        notice = "Выберите балл";
      } else if (action === "setscore") {
        const score = Number(parts[3]);
        if (!Number.isFinite(score) || score < 0 || score > 10) throw new Error("Некорректный балл");
        updateVacancySettings(vacancyId, { minScore: score });
        view = vacancyMainView(vacancyId);
        notice = `Проходной балл: ${score} (демо)`;
      } else if (action === "customscore") {
        pendingSettingsInput.set(key, { type: "score", vacancyId, menuMessageId: messageId, returnTo: "main" });
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Жду число от 0 до 10" });
        await editMessage(message.chat.id, messageId, scoreInputView(vacancyId));
        return;
      } else if (action === "filters") {
        view = filtersView(vacancyId, Number(parts[3]));
        notice = "Фильтры";
      } else if (action === "filter") {
        view = filterDetailView(vacancyId, Number(parts[3]));
        notice = "Фильтр открыт";
      } else if (action === "filterweight") {
        view = filterScoringView(vacancyId, Number(parts[3]));
        notice = "Выберите вес";
      } else if (action === "editfilter") {
        const filterIndex = Number(parts[3]);
        const current = getVacancySettings(vacancyId);
        if (!current?.filters?.[filterIndex]) throw new Error("Фильтр не найден");
        pendingSettingsInput.set(key, {
          type: "filter_text_edit",
          vacancyId,
          filterIndex,
          menuMessageId: messageId,
          returnTo: "filterDetail",
        });
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Введите новый текст" });
        await editMessage(message.chat.id, messageId, filterInputView(vacancyId, "", "ИЗМЕНИТЬ ФИЛЬТР"));
        return;
      } else if (action === "addfilter") {
        const current = getVacancySettings(vacancyId);
        if (current.filters.length >= 50) throw new Error("Можно добавить не более 50 фильтров");
        pendingSettingsInput.set(key, {
          type: "filter_text_new",
          vacancyId,
          menuMessageId: messageId,
          returnTo: "filters",
          page: Number(parts[3]) || 0,
        });
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Жду текст фильтра" });
        await editMessage(message.chat.id, messageId, filterInputView(vacancyId));
        return;
      } else if (action === "filterauto") {
        const filterIndex = Number(parts[3]);
        const direction = parts[4] === "minus" ? "minus" : "plus";
        const current = getVacancySettings(vacancyId);
        if (!current?.filters?.[filterIndex]) throw new Error("Фильтр не найден");
        const filters = current.filters.map((item, index) => (
          index === filterIndex ? { ...item, scoring: { mode: "auto", direction } } : item
        ));
        updateVacancySettings(vacancyId, { filters });
        view = filterDetailView(vacancyId, filterIndex);
        notice = direction === "plus" ? "Установлено Авто +" : "Установлено Авто −";
      } else if (action === "filterfixed") {
        const filterIndex = Number(parts[3]);
        const current = getVacancySettings(vacancyId);
        const filter = current?.filters?.[filterIndex];
        if (!filter) throw new Error("Фильтр не найден");
        pendingSettingsInput.set(key, {
          type: "filter_points_edit",
          vacancyId,
          filterIndex,
          menuMessageId: messageId,
          returnTo: "filterDetail",
        });
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Введите вес" });
        await editMessage(message.chat.id, messageId, filterPointsInputView(vacancyId, filter.text));
        return;
      } else if (action === "newfilterauto") {
        const pending = pendingSettingsInput.get(key);
        if (!pending || pending.type !== "filter_new_scoring" || pending.vacancyId !== vacancyId) throw new Error("Новый фильтр не найден");
        const direction = parts[3] === "minus" ? "minus" : "plus";
        const current = getVacancySettings(vacancyId);
        updateVacancySettings(vacancyId, {
          filters: [...current.filters, { text: pending.draftText, scoring: { mode: "auto", direction } }],
        });
        pendingSettingsInput.delete(key);
        view = filtersView(vacancyId, Math.floor(current.filters.length / FILTERS_PER_PAGE));
        notice = direction === "plus" ? "Добавлен Авто +" : "Добавлен Авто −";
      } else if (action === "newfilterfixed") {
        const pending = pendingSettingsInput.get(key);
        if (!pending || pending.type !== "filter_new_scoring" || pending.vacancyId !== vacancyId) throw new Error("Новый фильтр не найден");
        pending.type = "filter_points_new";
        pendingSettingsInput.set(key, pending);
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Введите вес" });
        await editMessage(message.chat.id, messageId, filterPointsInputView(vacancyId, pending.draftText));
        return;
      } else if (action === "askdel") {
        view = deleteFilterView(vacancyId, Number(parts[3]));
        notice = "Подтвердите удаление";
      } else if (action === "delfilter") {
        const index = Number(parts[3]);
        const current = getVacancySettings(vacancyId);
        if (!current || !Number.isInteger(index) || index < 0 || index >= current.filters.length) throw new Error("Фильтр уже удалён");
        updateVacancySettings(vacancyId, { filters: current.filters.filter((_, itemIndex) => itemIndex !== index) });
        const remainingCount = current.filters.length - 1;
        const lastPage = Math.max(0, Math.ceil(remainingCount / FILTERS_PER_PAGE) - 1);
        view = filtersView(vacancyId, Math.min(Math.floor(index / FILTERS_PER_PAGE), lastPage));
        notice = "Фильтр удалён (демо)";
      } else if (action === "cancelinput") {
        const pending = pendingSettingsInput.get(key);
        pendingSettingsInput.delete(key);
        view = pending ? pendingCancelView(pending) : vacancyMainView(vacancyId);
        notice = "Ввод отменён";
      } else {
        throw new Error("Неизвестная кнопка настроек");
      }

      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: notice });
      if (view) await editMessage(message.chat.id, messageId, view);
    } catch (error) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: error.message || "Ошибка", show_alert: true });
    }
    return;
  }
  await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Демо: рабочее действие не выполнялось", show_alert: true });
  if (data === "test:confirm") await sendMessage(message.chat.id, "📨 Кандидату отправлено сообщение:\n\n<blockquote>Елена, здравствуйте! Напоминаем, что сегодня, 25 августа, ждём вас на собеседование в 11:00. Подтвердите, пожалуйста, что сможете подойти.</blockquote>\n\nЖду ответ кандидата в HH.\n\n<i>🧪 ДЕМО: фактически в HH ничего не отправлено.</i>");
  if (data === "test:cancel") await sendMessage(message.chat.id, "Встреча отменена.\n\n<i>🧪 ДЕМО: календарь и HH не изменялись.</i>");
}

async function run() {
  selfTest();
  await telegram("deleteWebhook", { drop_pending_updates: false });
  await telegram("setMyCommands", { commands: [
    { command: "start", description: "Инструкция" },
    { command: "next", description: "Следующее сообщение" },
    { command: "all", description: "Показать все случаи" },
    { command: "list", description: "Список случаев" },
    { command: "show", description: "Показать случай по номеру" },
    { command: "settings", description: "Настройки вакансий (демо)" },
  ] });
  const me = await telegram("getMe");
  console.log(`Message lab started: @${me.username}`);
  let offset = 0;
  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.message) await handleMessage(update.message);
          else if (update.callback_query) await handleCallback(update.callback_query);
        } catch (error) {
          console.error("Update error:", error.message);
        }
      }
    } catch (error) {
      if (!stopping) {
        console.error("Polling error:", error.message);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

run().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
