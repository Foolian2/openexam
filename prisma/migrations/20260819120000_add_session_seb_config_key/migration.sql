-- Per-session SEB Config Key for the personalized .seb config whose startURL
-- carries a one-time login token (app/exam/[id]/seb-enter/route.ts).
--
-- Purely additive: Exam."sebConfigKey" stays the frozen canonical key for the
-- anonymous config, and lib/seb-guard.ts accepts a token matching either. No
-- backfill is needed precisely because of that fallback — a session that has
-- never fetched a personalized config leaves this NULL and keeps validating
-- against the exam-level key exactly as it did before this column existed.
ALTER TABLE "ExamSession" ADD COLUMN "sebConfigKey" TEXT;
