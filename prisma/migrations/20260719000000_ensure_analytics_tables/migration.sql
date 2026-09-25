-- These tables were originally introduced with `prisma db push` on production.
-- Keep an idempotent migration so a clean installation can be created only
-- from the migration history.

CREATE TABLE IF NOT EXISTS "CandidateStageState" (
    "id" SERIAL NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "vacancyName" TEXT NOT NULL,
    "candidateName" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateStageState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CandidateStageState_negotiationId_key"
    ON "CandidateStageState"("negotiationId");
CREATE INDEX IF NOT EXISTS "CandidateStageState_vacancyId_idx"
    ON "CandidateStageState"("vacancyId");
CREATE INDEX IF NOT EXISTS "CandidateStageState_stage_idx"
    ON "CandidateStageState"("stage");

CREATE TABLE IF NOT EXISTS "VacancyStageCurrent" (
    "vacancyId" TEXT NOT NULL,
    "vacancyName" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VacancyStageCurrent_pkey" PRIMARY KEY ("vacancyId", "stage")
);

CREATE TABLE IF NOT EXISTS "VacancyStageSnapshot" (
    "id" SERIAL NOT NULL,
    "vacancyId" TEXT NOT NULL,
    "vacancyName" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VacancyStageSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VacancyStageSnapshot_vacancyId_capturedAt_idx"
    ON "VacancyStageSnapshot"("vacancyId", "capturedAt");
