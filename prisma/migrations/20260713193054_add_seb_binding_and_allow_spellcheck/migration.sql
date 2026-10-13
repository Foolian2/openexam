-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "allowSpellCheck" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ExamSession" ADD COLUMN     "sebKeyHash" TEXT,
ADD COLUMN     "sebUserAgent" TEXT;
