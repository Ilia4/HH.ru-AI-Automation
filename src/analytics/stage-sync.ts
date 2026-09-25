import { prisma } from "../lib/prisma";
import { listTrackedVacancies } from "../chat-sim/vacancies";
import {
    getNegotiationCollections,
    getNegotiationsByCollection,
    type HhNegotiation,
} from "../hhru/hh-api";
import { withHhAccount } from "../hh-auth/account-context";

function candName(n: HhNegotiation): string {
    return [n.resume?.last_name, n.resume?.first_name, n.resume?.middle_name].filter(Boolean).join(" ")
        || n.resume?.title || String(n.id);
}

/**
 * Тянет с HH счётчики по всем стадиям каждой вакансии и складывает в локальную базу:
 *  - VacancyStageCurrent — актуальный срез (перезаписывается);
 *  - CandidateStageState — по каждому кандидату (для «новых за период», «кто в стадии»).
 * ИИ читает потом ТОЛЬКО из базы, к HH не ходит.
 */
export async function refreshStageCounts(): Promise<void> {
    let vacancies;
    try {
        vacancies = await listTrackedVacancies();
    } catch (e: any) {
        console.error("[stage-sync] не смог прочитать вакансии:", e.message);
        return;
    }

    for (const v of vacancies) {
        let colls;
        try {
            colls = await withHhAccount(v.hhAccountId, () => getNegotiationCollections(v.vacancyId));
        } catch (e: any) {
            console.error(`[stage-sync] коллекции «${v.vacancyName}»:`, e.message);
            continue;
        }

        // 1) актуальные счётчики по стадиям — одним махом
        for (const c of colls) {
            try {
                await prisma.vacancyStageCurrent.upsert({
                    where: { vacancyId_stage: { vacancyId: v.vacancyId, stage: c.id } },
                    create: {
                        vacancyId: v.vacancyId,
                        hhAccountId: v.hhAccountId,
                        vacancyName: v.vacancyName,
                        stage: c.id,
                        stageName: c.name,
                        count: c.total,
                    },
                    update: { count: c.total, stageName: c.name, vacancyName: v.vacancyName, hhAccountId: v.hhAccountId },
                });
            } catch (e: any) {
                console.error(`[stage-sync] upsert current ${v.vacancyId}/${c.id}:`, e.message);
            }
        }

        // 2) по кандидатам — только непустые стадии (для истории появления/переходов)
        const now = new Date();
        for (const c of colls) {
            if (!c.total) continue;
            let page = 0;
            while (true) {
                let d: any;
                try {
                    d = await withHhAccount(v.hhAccountId, () =>
                        getNegotiationsByCollection(c.id, v.vacancyId, page)
                    );
                } catch (e: any) {
                    console.error(`[stage-sync] items ${v.vacancyId}/${c.id} p${page}:`, e.message);
                    break;
                }
                for (const it of (d.items || []) as HhNegotiation[]) {
                    const negId = String(it.id);
                    const name = candName(it);
                    // реальная дата отклика из HH — чтобы «новые за период» считались честно
                    const createdRaw = (it as any).created_at;
                    const createdAt = createdRaw && !isNaN(Date.parse(createdRaw)) ? new Date(createdRaw) : now;
                    try {
                        const ex = await prisma.candidateStageState.findUnique({ where: { negotiationId: negId } });
                        if (!ex) {
                            await prisma.candidateStageState.create({
                                data: {
                                    negotiationId: negId,
                                    vacancyId: v.vacancyId,
                                    hhAccountId: v.hhAccountId,
                                    vacancyName: v.vacancyName,
                                    candidateName: name,
                                    stage: c.id,
                                    stageName: c.name,
                                    firstSeenAt: createdAt,
                                    stageChangedAt: createdAt,
                                },
                            });
                        } else {
                            const moved = ex.stage !== c.id;
                            await prisma.candidateStageState.update({
                                where: { negotiationId: negId },
                                data: {
                                    stage: c.id,
                                    stageName: c.name,
                                    vacancyName: v.vacancyName,
                                    hhAccountId: v.hhAccountId,
                                    candidateName: name,
                                    lastSeenAt: now,
                                    firstSeenAt: createdAt,
                                    ...(moved ? { stageChangedAt: now } : {}),
                                },
                            });
                        }
                    } catch (e: any) {
                        console.error(`[stage-sync] upsert cand ${negId}:`, e.message);
                    }
                }
                if (page >= (d.pages || 1) - 1) break;
                page++;
            }
        }
    }
    console.log(`[stage-sync] обновлены счётчики по ${vacancies.length} вакансиям`);
}

/** Снимок текущих счётчиков в историю (для вопросов про динамику). Раз в 30 минут. */
export async function snapshotStageHistory(): Promise<void> {
    try {
        const rows = await prisma.vacancyStageCurrent.findMany();
        if (!rows.length) return;
        await prisma.vacancyStageSnapshot.createMany({
            data: rows.map((r) => ({
                vacancyId: r.vacancyId,
                hhAccountId: r.hhAccountId,
                vacancyName: r.vacancyName,
                stage: r.stage,
                stageName: r.stageName,
                count: r.count,
            })),
        });
        console.log(`[stage-sync] снимок истории: ${rows.length} строк`);
    } catch (e: any) {
        console.error("[stage-sync] снимок истории:", e.message);
    }
}
