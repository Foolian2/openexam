ALTER TABLE "ExamSession"
ADD COLUMN "deadlineFinalizationPending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ExamSession_deadline_live_idx"
ON "ExamSession" ("effectiveEndTime", id)
WHERE status IN ('IN_PROGRESS', 'LOCKED');

CREATE INDEX "ExamSession_deadline_pending_idx"
ON "ExamSession" (id)
WHERE "deadlineFinalizationPending" = true;
