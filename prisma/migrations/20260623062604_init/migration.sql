-- AlterTable
ALTER TABLE "User" ADD COLUMN     "email" TEXT;

-- CreateTable
CREATE TABLE "InterviewNotification" (
    "id" SERIAL NOT NULL,
    "eventKey" TEXT NOT NULL,
    "vacancyName" TEXT NOT NULL,
    "candidateFullName" TEXT NOT NULL,
    "resumeUrl" TEXT,
    "interviewAt" TIMESTAMP(3) NOT NULL,
    "reminderAt" TIMESTAMP(3) NOT NULL,
    "contactCandidate" TEXT,
    "responsibleUsername" TEXT NOT NULL,
    "responsibleUserId" INTEGER,
    "sheetRow" INTEGER,
    "sheetName" TEXT,
    "firstNotificationSentAt" TIMESTAMP(3),
    "reminder30SentAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InterviewNotification_eventKey_key" ON "InterviewNotification"("eventKey");

-- AddForeignKey
ALTER TABLE "InterviewNotification" ADD CONSTRAINT "InterviewNotification_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
