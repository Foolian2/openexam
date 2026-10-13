-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "sebQuitPassword" TEXT;

-- Existing SEB exams carry a Config Key derived from the old settings dict (no
-- hashedQuitPassword, no allowUploads, a /complete quit URL). That key no longer
-- matches what SEB will compute from a freshly generated .seb file, and the
-- request guard fails closed — so those exams would deny every student.
-- Clearing the stale key forces it to be regenerated together with the new quit
-- password; run `pnpm tsx scripts/regenerate-seb-config-keys.ts` to backfill both
-- in one pass. The seb-config route also regenerates lazily on next download.
UPDATE "Exam" SET "sebConfigKey" = NULL WHERE "sebRequired" = true;
