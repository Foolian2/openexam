-- AlterTable
ALTER TABLE "Answer" ADD COLUMN "clientSeq" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ExamSession" ADD COLUMN "needsRegrade" BOOLEAN NOT NULL DEFAULT false;
