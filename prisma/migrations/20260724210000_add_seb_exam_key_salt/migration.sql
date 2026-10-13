-- Pinned per-exam HMAC salt for SEB's Browser Exam Key derivation.
-- Nullable: existing exams keep the pre-BEK behaviour until a config is
-- generated, which is what backfills the salt (lib/seb-secrets.ts).
ALTER TABLE "Exam" ADD COLUMN "sebExamKeySalt" BYTEA;
