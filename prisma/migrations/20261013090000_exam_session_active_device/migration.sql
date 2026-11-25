-- AlterTable
ALTER TABLE "ExamSession" ADD COLUMN     "activeAuthSessionId" TEXT,
ADD COLUMN     "deviceReplacedAt" TIMESTAMP(3),
ADD COLUMN     "deviceReplacedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "claimVersion" INTEGER NOT NULL DEFAULT 0;
