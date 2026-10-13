-- The live-monitor/active-exam-count endpoint queries
-- WHERE "examId" = ? ORDER BY "startedAt" with no status filter, so the
-- existing (examId, status) index doesn't help its sort — this one does.
CREATE INDEX "ExamSession_examId_startedAt_idx" ON "ExamSession"("examId", "startedAt");
