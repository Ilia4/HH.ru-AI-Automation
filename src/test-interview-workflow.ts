import assert from "node:assert/strict";
import {
    reconcileCandidateDecision,
    reconcileHumanDecision,
    validateSlot,
    type CandidateDecision,
    type HumanDecision,
} from "./hhru/interview-chat";
import { bookingBelongsToCandidate, normalizeTime } from "./hhru/interview-calendar";
import { repeatsScheduledSlotWithoutCancellation } from "./hhru/interview-confirm";

function ai(action: HumanDecision["action"], date = "", time = ""): HumanDecision {
    return { action, candidate_reply: "текст ИИ", date, time, reason: "test" };
}

function candidateAi(action: CandidateDecision["action"], date = "", time = ""): CandidateDecision {
    return { action, date, time, reason: "test" };
}

// Реальный сбой: ИИ ошибочно увидел подтверждение старого слота в обычном вопросе HR.
const noShowQuestion = "Елена, добрый день! Мы ожидали Вас сегодня на собеседование в 11-00. Подскажите, актуальна ли еще вакансия?";
const safeNoShow = reconcileHumanDecision(noShowQuestion, ai("confirm_candidate_time", "2026-08-25", "11:00"));
assert.equal(safeNoShow.action, "ask_candidate");
assert.equal(safeNoShow.candidate_reply, noShowQuestion, "в HH должен уйти исходный текст HR без переписывания ИИ");
assert.equal(
    reconcileHumanDecision(noShowQuestion, ai("offer_new_time", "2026-08-25", "11:00")).action,
    "ask_candidate",
    "даже ошибку ИИ offer_new_time нужно обезвредить",
);

assert.equal(
    reconcileHumanDecision("Да, это время подходит. Ждём вас.", ai("confirm_candidate_time")).action,
    "confirm_candidate_time",
);
assert.equal(
    reconcileHumanDecision("Удобно будет подойти 26.08 в 12:00?", ai("offer_new_time", "2026-08-26", "12:00")).action,
    "offer_new_time",
);
assert.equal(
    reconcileHumanDecision(
        "Ждём вас 26.08 в 12:00.",
        ai("confirm_candidate_time", "2026-08-26", "12:00"),
        { date: "25.08.2026", time: "11:00" },
    ).action,
    "offer_new_time",
    "новый слот HR нельзя принять за подтверждение старого слота кандидата",
);
const humanSlotWinsOverAi = reconcileHumanDecision(
    "Ждём вас 26.08 в 12-00.",
    ai("confirm_candidate_time", "2026-08-25", "11:00"),
    { date: "25.08.2026", time: "11:00" },
);
assert.equal(humanSlotWinsOverAi.action, "offer_new_time");
assert.deepEqual(
    { date: humanSlotWinsOverAi.date, time: humanSlotWinsOverAi.time },
    { date: "26.08.2026", time: "12:00" },
    "явно написанное HR время должно быть надёжнее ошибочно извлечённого ИИ",
);
assert.equal(
    reconcileHumanDecision(
        "Да, ждём вас 25.08 в 11:00.",
        ai("confirm_candidate_time", "2026-08-25", "11:00"),
        { date: "25.08.2026", time: "11:00" },
    ).action,
    "confirm_candidate_time",
);
assert.equal(
    reconcileHumanDecision(
        "Мы ждали вас сегодня в 11:00. Давайте завтра в 12:00.",
        ai("offer_new_time", "2026-08-26", "12:00"),
        { date: "25.08.2026", time: "11:00" },
    ).action,
    "offer_new_time",
    "реальное новое предложение после упоминания старой встречи должно сохраниться",
);
assert.equal(
    reconcileHumanDecision("Подтверждаете встречу 26.08 в 12:00?", ai("confirm_candidate_time", "2026-08-26", "12:00")).action,
    "ask_candidate",
    "вопрос кандидату нельзя превращать в немедленную бронь",
);

// 25.08.2026 11:00 МСК = 08:00 UTC.
assert.match(
    validateSlot({ date: "25.08.2026", time: "11:00" }, Date.UTC(2026, 7, 25, 9, 0)) || "",
    /уже прошло/,
);
assert.equal(validateSlot({ date: "26.08.2026", time: "12:00" }, Date.UTC(2026, 7, 25, 9, 0)), null);
assert.match(validateSlot({ date: "31.02.2026", time: "12:00" }, 0) || "", /корректную дату/);
assert.equal(normalizeTime("11-00"), "11:00");

const employerSlot = { date: "26.08.2026", time: "12:00" };
assert.equal(
    reconcileCandidateDecision("Спасибо Вам 🙂", candidateAi("accept_time"), employerSlot).action,
    "unclear",
    "благодарность нельзя автоматически считать согласием на встречу",
);
assert.equal(
    reconcileCandidateDecision("Да, время подходит", candidateAi("accept_time"), employerSlot).action,
    "accept_time",
);
assert.equal(
    reconcileCandidateDecision("Я же согласилась на 26.08 в 12:00", candidateAi("propose_time", "2026-08-26", "12:00"), employerSlot).action,
    "accept_time",
    "повтор слота работодателя должен считаться подтверждением",
);
assert.equal(
    reconcileCandidateDecision("Нет, смогу 27.08 в 13:00", candidateAi("accept_time", "2026-08-27", "13:00"), employerSlot).action,
    "propose_time",
    "другой слот кандидата нельзя принять за согласие со старым",
);
assert.equal(
    reconcileCandidateDecision("Нет, это время не подходит", candidateAi("accept_time"), employerSlot).action,
    "unclear",
    "отрицание со словом «подходит» не является согласием",
);
const candidateDifferentWithoutAiDate = reconcileCandidateDecision(
    "Смогу 27.08 в 13-00",
    candidateAi("accept_time"),
    employerSlot,
);
assert.equal(candidateDifferentWithoutAiDate.action, "propose_time");
assert.deepEqual(
    { date: candidateDifferentWithoutAiDate.date, time: candidateDifferentWithoutAiDate.time },
    { date: "27.08.2026", time: "13:00" },
    "явно написанный слот должен быть надёжнее неполного ответа ИИ",
);

const booking = {
    vacancyName: "Тест",
    candidateFullName: "Богомолова Елена Юрьевна",
    resumeUrl: "https://hh.ru/resume/abc?t=123",
    date: "26.08.2026",
    time: "12:00",
};
assert.equal(bookingBelongsToCandidate(booking, "Богомолова Елена Юрьевна", "https://hh.ru/resume/abc?t=999"), true);
assert.equal(bookingBelongsToCandidate(booking, "Другой Кандидат", "https://hh.ru/resume/other"), false);

const scheduled = { date: "25.08.2026", time: "11:00" };
assert.equal(repeatsScheduledSlotWithoutCancellation("Я же перенесла встречу на 25.08 в 11:00", scheduled), true);
assert.equal(repeatsScheduledSlotWithoutCancellation("Не смогу 25.08 в 11:00, жду новое время", scheduled), false);

console.log("interview-workflow: ok");
