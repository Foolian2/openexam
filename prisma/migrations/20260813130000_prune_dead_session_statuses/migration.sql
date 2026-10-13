-- Prune SessionStatus (WAITING, DISCONNECTED) and SubmissionType
-- (AUTO_DISCONNECT) values that are never written by app code. Postgres
-- cannot drop enum values in place, so Prisma type-swaps each enum. The
-- UPDATEs below defensively migrate any legacy rows before the swap.

UPDATE "ExamSession" SET "status" = 'IN_PROGRESS' WHERE "status" IN ('WAITING', 'DISCONNECTED');
UPDATE "ExamSession" SET "submissionType" = 'MANUAL' WHERE "submissionType" = 'AUTO_DISCONNECT';

-- AlterEnum
BEGIN;
CREATE TYPE "SessionStatus_new" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'LOCKED');
ALTER TABLE "public"."ExamSession" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ExamSession" ALTER COLUMN "status" TYPE "SessionStatus_new" USING ("status"::text::"SessionStatus_new");
ALTER TYPE "SessionStatus" RENAME TO "SessionStatus_old";
ALTER TYPE "SessionStatus_new" RENAME TO "SessionStatus";
DROP TYPE "public"."SessionStatus_old";
ALTER TABLE "ExamSession" ALTER COLUMN "status" SET DEFAULT 'IN_PROGRESS';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "SubmissionType_new" AS ENUM ('MANUAL', 'AUTO_TIME', 'TEACHER_FORCED');
ALTER TABLE "ExamSession" ALTER COLUMN "submissionType" TYPE "SubmissionType_new" USING ("submissionType"::text::"SubmissionType_new");
ALTER TYPE "SubmissionType" RENAME TO "SubmissionType_old";
ALTER TYPE "SubmissionType_new" RENAME TO "SubmissionType";
DROP TYPE "public"."SubmissionType_old";
COMMIT;
