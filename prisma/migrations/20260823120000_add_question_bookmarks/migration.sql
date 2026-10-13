CREATE TABLE "QuestionBookmark" (
  "sessionId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestionBookmark_pkey" PRIMARY KEY ("sessionId", "questionId")
);

CREATE INDEX "QuestionBookmark_questionId_idx" ON "QuestionBookmark"("questionId");

ALTER TABLE "QuestionBookmark"
  ADD CONSTRAINT "QuestionBookmark_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QuestionBookmark"
  ADD CONSTRAINT "QuestionBookmark_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
