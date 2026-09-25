import assert from "node:assert/strict";
import { decorate } from "./hhru/candidate-tags";
import {
    buildCandidateCard,
    resumeLinkHtml,
    safeHhResumeUrl,
} from "./hhru/telegram-cards";

const resumeUrl = "https://voronezh.hh.ru/resume/abc123?t=neg456";
const card = buildCandidateCard({
    header: "❓ КАНДИДАТУ НУЖЕН ОТВЕТ",
    candidateName: "Иванов <Иван>",
    vacancyName: "Начальник & руководитель",
    stage: "Анализ резюме",
    quote: "Есть ли <обучение>?",
    action: "Ответьте reply.",
});
const decorated = decorate(card, {
    vacancyName: "Начальник & руководитель",
    vacancyId: "123",
    candidateName: "Иванов Иван Иванович",
    resumeUrl,
    html: true,
});

assert.match(card, /Иванов &lt;Иван&gt;/);
assert.match(card, /Начальник &amp; руководитель/);
assert.match(card, /<blockquote>Есть ли &lt;обучение&gt;\?<\/blockquote>/);
assert.match(decorated.text, /<a href="https:\/\/voronezh\.hh\.ru\/resume\/abc123\?t=neg456">Резюме кандидата<\/a>/);
assert.ok(decorated.text.endsWith("Резюме кандидата</a>"), "ссылка на резюме должна быть внизу");
assert.equal(safeHhResumeUrl("https://evil.example/resume/abc"), "");
assert.equal(resumeLinkHtml("javascript:alert(1)"), "");

console.log("telegram-cards: ok");
