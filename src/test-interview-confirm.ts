import assert from "node:assert/strict";
import {
    candidateConfirmationQuestion,
    isConfirmationWindowOpen,
    reconcileScheduledMessageDecision,
    repeatsScheduledSlotWithoutCancellation,
    shouldCompleteMeeting,
} from "./hhru/interview-confirm";

const slot = { date: "25.08.2026", time: "11:00" };

assert.equal(
    repeatsScheduledSlotWithoutCancellation("Я же вроде перенесла встречу на 25.08 в 11:00!??", slot),
    true,
    "повтор уже назначенного слота должен считаться подтверждением",
);
assert.equal(
    repeatsScheduledSlotWithoutCancellation("Не смогу 25.08 в 11:00, давайте перенесём", slot),
    false,
    "явная просьба о переносе не должна считаться подтверждением",
);
assert.equal(
    repeatsScheduledSlotWithoutCancellation("Спасибо Вам 🙂", slot),
    false,
    "обычная благодарность не является подтверждением конкретного слота",
);

// 25.08.2026 11:00 МСК = 08:00 UTC; окно подтверждения начинается в 06:00 UTC.
assert.equal(isConfirmationWindowOpen(slot, Date.UTC(2026, 7, 25, 5, 59)), false);
assert.equal(isConfirmationWindowOpen(slot, Date.UTC(2026, 7, 25, 6, 0)), true);
assert.equal(isConfirmationWindowOpen(slot, Date.UTC(2026, 7, 25, 8, 0)), false);
assert.equal(isConfirmationWindowOpen(slot, Date.UTC(2026, 7, 25, 8, 1)), false);

assert.equal(
    candidateConfirmationQuestion("Богомолова Елена Юрьевна", slot, Date.UTC(2026, 7, 25, 7, 0)),
    "Елена, здравствуйте! Напоминаем, что сегодня, 25 августа, ждём вас на собеседование в 11:00. Подтвердите, пожалуйста, что сможете подойти.",
);
assert.match(
    candidateConfirmationQuestion("Богомолова Елена Юрьевна", { date: "26.08.2026", time: "14:30" }, Date.UTC(2026, 7, 25, 7, 0)),
    /завтра, 26 августа.*14:30/,
);

assert.equal(reconcileScheduledMessageDecision("Спасибо Вам 🙂", "reschedule", slot), "other");
assert.equal(reconcileScheduledMessageDecision("Как к вам проехать?", "confirmed", slot), "other");
assert.equal(reconcileScheduledMessageDecision("Да, всё в силе", "confirmed", slot), "confirmed");
assert.equal(
    reconcileScheduledMessageDecision("Доброе утро. Уже еду. Могу минут на 5 задержаться.", "other", slot),
    "confirmed",
    "дорога на встречу и небольшое опоздание являются подтверждением",
);
assert.equal(reconcileScheduledMessageDecision("Уже в пути", "other", slot), "confirmed");
assert.equal(reconcileScheduledMessageDecision("Выехала, скоро буду", "other", slot), "confirmed");
assert.equal(reconcileScheduledMessageDecision("Подъезжаю", "other", slot), "confirmed");
assert.equal(reconcileScheduledMessageDecision("Опоздаю примерно на 10 минут", "other", slot), "confirmed");
assert.equal(reconcileScheduledMessageDecision("Я не еду, встречу нужно перенести", "confirmed", slot), "reschedule");
assert.equal(reconcileScheduledMessageDecision("Сегодня не буду", "confirmed", slot), "reschedule");
assert.equal(reconcileScheduledMessageDecision("Сегодня не смогу приехать, давайте перенесём", "reschedule", slot), "reschedule");
assert.equal(reconcileScheduledMessageDecision("А можно 26.08 в 14:00?", "reschedule", slot), "reschedule");
assert.equal(
    reconcileScheduledMessageDecision("Я же перенесла встречу на 25.08 в 11:00", "reschedule", slot),
    "confirmed",
);

assert.equal(shouldCompleteMeeting("scheduled", slot, Date.UTC(2026, 7, 25, 7, 59)), false);
assert.equal(shouldCompleteMeeting("scheduled", slot, Date.UTC(2026, 7, 25, 8, 0)), true);
assert.equal(shouldCompleteMeeting("awaiting_candidate_confirm", slot, Date.UTC(2026, 7, 25, 9, 0)), true);
assert.equal(shouldCompleteMeeting("completed", slot, Date.UTC(2026, 7, 25, 9, 0)), false);

console.log("interview-confirm: ok");
