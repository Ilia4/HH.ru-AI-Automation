import { formatInterviewDateMoscow, formatInterviewTimeMoscow } from "./notifications/notifications.service";

const vlasovaUtc = new Date(Date.UTC(2026, 8, 9, 7, 0));
const chertovUtc = new Date(Date.UTC(2026, 8, 9, 10, 30));

const actual = {
    date: formatInterviewDateMoscow(vlasovaUtc),
    vlasova: formatInterviewTimeMoscow(vlasovaUtc),
    chertov: formatInterviewTimeMoscow(chertovUtc),
};

if (actual.date !== "09.09.2026") throw new Error(`wrong date: ${actual.date}`);
if (actual.vlasova !== "10:00") throw new Error(`wrong Vlasova time: ${actual.vlasova}`);
if (actual.chertov !== "13:30") throw new Error(`wrong Chertov time: ${actual.chertov}`);

console.log(JSON.stringify(actual));
