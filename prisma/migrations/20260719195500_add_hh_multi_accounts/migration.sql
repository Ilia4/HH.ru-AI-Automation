-- HH.ru multi-account support.
-- Existing token data is migrated by the deployment script after this schema migration.

CREATE TABLE "HhAccount" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "hhUserId" TEXT,
    "managerId" TEXT,
    "employerId" TEXT,
    "employerName" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdByTgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HhAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HhAccount_email_key" ON "HhAccount"("email");
CREATE INDEX "HhAccount_status_idx" ON "HhAccount"("status");
CREATE INDEX "HhAccount_employerId_idx" ON "HhAccount"("employerId");

CREATE TABLE "HhOAuthSession" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER,

    CONSTRAINT "HhOAuthSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HhOAuthSession_state_key" ON "HhOAuthSession"("state");
CREATE INDEX "HhOAuthSession_expiresAt_idx" ON "HhOAuthSession"("expiresAt");

ALTER TABLE "ActiveVacancy" ADD COLUMN "vacancyId" TEXT;
ALTER TABLE "ActiveVacancy" ADD COLUMN "hhAccountId" TEXT;
CREATE INDEX "ActiveVacancy_hhAccountId_idx" ON "ActiveVacancy"("hhAccountId");

ALTER TABLE "ActiveVacancy"
    ADD CONSTRAINT "ActiveVacancy_hhAccountId_fkey"
    FOREIGN KEY ("hhAccountId") REFERENCES "HhAccount"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HhOAuthSession"
    ADD CONSTRAINT "HhOAuthSession_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CandidateStageState" ADD COLUMN "hhAccountId" TEXT;
ALTER TABLE "VacancyStageCurrent" ADD COLUMN "hhAccountId" TEXT;
ALTER TABLE "VacancyStageSnapshot" ADD COLUMN "hhAccountId" TEXT;
CREATE INDEX "CandidateStageState_hhAccountId_idx" ON "CandidateStageState"("hhAccountId");
CREATE INDEX "VacancyStageSnapshot_hhAccountId_idx" ON "VacancyStageSnapshot"("hhAccountId");
