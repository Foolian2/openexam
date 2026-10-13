-- Trust-on-first-use binding for the SEB Browser Exam Key.
-- All nullable: a session that never presents a BEK behaves exactly as before,
-- and the flag columns stay null until something actually changes mid-exam.
ALTER TABLE "ExamSession" ADD COLUMN "sebBrowserExamKey" TEXT;
ALTER TABLE "ExamSession" ADD COLUMN "sebIntegrityFlaggedAt" TIMESTAMP(3);
ALTER TABLE "ExamSession" ADD COLUMN "sebIntegrityReason" TEXT;
