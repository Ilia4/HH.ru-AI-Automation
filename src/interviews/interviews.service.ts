import { prisma } from "../lib/prisma.js";
import { listInterviewBookings, normalizeDate, normalizeTime, type InterviewBooking } from "../hhru/interview-calendar";

function parseInterviewDateTime(date: string, time: string): Date | null {
    const normalizedDate = normalizeDate(date);
    const normalizedTime = normalizeTime(time);
    if (!normalizedDate || !normalizedTime) return null;

    const [day, month, year] = normalizedDate.split(".").map(Number);
    const [hours, minutes] = normalizedTime.split(":").map(Number);
    // Время собеседования в таблице указано по Москве (UTC+3).
    // Сохраняем корректный абсолютный момент в UTC (не зависит от TZ сервера).
    const dt = new Date(Date.UTC(year, month - 1, day, hours - 3, minutes, 0, 0));
    return isNaN(dt.getTime()) ? null : dt;
}

async function getInterviewsFromGS(): Promise<InterviewBooking[]> {
    return listInterviewBookings();
}

export async function syncInterviewNotifications() {
    const interviews = await getInterviewsFromGS();
    let created = 0;
    let skipped = 0;

    for (const interview of interviews) {
        const vacancy = await prisma.activeVacancy.findUnique({
            where: { vacancyName: interview.vacancyName },
        });

        if (!vacancy || !vacancy.isActive) {
            console.log(`[interviews] vacancy not found or inactive: "${interview.vacancyName}", skip`);
            skipped++;
            continue;
        }

        const interviewAt = parseInterviewDateTime(interview.date, interview.time);
        if (!interviewAt) {
            console.log(`[interviews] cannot parse date: "${interview.date} ${interview.time}", skip`);
            skipped++;
            continue;
        }

        const reminderAt = new Date(interviewAt.getTime() - 30 * 60 * 1000);
        const eventKey = [interview.vacancyName, interview.candidateFullName, normalizeDate(interview.date), normalizeTime(interview.time)]
            .join("__")
            .replace(/s+/g, "_");

        const existing = await prisma.interviewNotification.findUnique({ where: { eventKey } });
        if (existing) {
            skipped++;
            continue;
        }

        await prisma.interviewNotification.create({
            data: {
                eventKey,
                vacancyName: interview.vacancyName,
                candidateFullName: interview.candidateFullName,
                resumeUrl: interview.resumeUrl || null,
                interviewAt,
                reminderAt,
                contactCandidate: interview.contactCandidate || null,
                activeVacancyId: vacancy.id,
                responsibleUsername: vacancy.responsibleUsername,
                responsibleUserId: vacancy.responsibleUserId ?? null,
                status: "active",
            },
        });

        created++;
        console.log(`[interviews] created: ${interview.vacancyName} ? ${interview.candidateFullName} (${interview.date} ${interview.time})`);
    }

    console.log(`[interviews] synced: created ${created}, skipped ${skipped}`);
}
