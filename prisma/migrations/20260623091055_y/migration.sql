-- AlterTable
ALTER TABLE "InterviewNotification" ADD COLUMN     "activeVacancyId" INTEGER;

-- CreateTable
CREATE TABLE "ActiveVacancy" (
    "id" SERIAL NOT NULL,
    "vacancyName" TEXT NOT NULL,
    "vacancyUrl" TEXT,
    "templatesUrl" TEXT,
    "responsibleUsername" TEXT NOT NULL,
    "responsibleUserId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActiveVacancy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActiveVacancy_vacancyName_key" ON "ActiveVacancy"("vacancyName");

-- AddForeignKey
ALTER TABLE "InterviewNotification" ADD CONSTRAINT "InterviewNotification_activeVacancyId_fkey" FOREIGN KEY ("activeVacancyId") REFERENCES "ActiveVacancy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActiveVacancy" ADD CONSTRAINT "ActiveVacancy_responsibleUserId_fkey" FOREIGN KEY ("responsibleUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
