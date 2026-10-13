-- AlterTable
ALTER TABLE "User" ADD COLUMN     "hideExamTimer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "highContrast" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reducedMotion" BOOLEAN NOT NULL DEFAULT false;
