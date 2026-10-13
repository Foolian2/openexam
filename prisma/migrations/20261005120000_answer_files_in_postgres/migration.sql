-- FILE_UPLOAD answers move from the MinIO bucket into Postgres (AnswerFile;
-- see its comment in schema.prisma). Production's bucket was empty at the
-- switch, so there is nothing to copy over.
CREATE TABLE "AnswerFile" (
  "key" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnswerFile_pkey" PRIMARY KEY ("key")
);

-- Uploads are mostly PDFs, images and Office/ZIP files, which are already
-- compressed: EXTERNAL keeps them out-of-line in TOAST (as EXTENDED would)
-- but skips the pglz/lz4 attempt that would only burn CPU on every write.
-- Not expressible in the Prisma DSL, so it lives only here (schema.prisma's
-- AnswerFile comment points back to this file).
ALTER TABLE "AnswerFile" ALTER COLUMN "data" SET STORAGE EXTERNAL;

CREATE INDEX "AnswerFile_sessionId_questionId_idx" ON "AnswerFile"("sessionId", "questionId");
CREATE INDEX "AnswerFile_questionId_idx" ON "AnswerFile"("questionId");

ALTER TABLE "AnswerFile"
  ADD CONSTRAINT "AnswerFile_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "ExamSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnswerFile"
  ADD CONSTRAINT "AnswerFile_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Uploads are capped at 25 MB now that every byte also lands in the
-- database and its backups (MAX_UPLOAD_MB, lib/upload-budget.ts). Clamp
-- stored configs so editors and students see the limit that is enforced.
UPDATE "Question"
SET "config" = jsonb_set("config", '{maxFileSizeMB}', '25')
WHERE "type" = 'FILE_UPLOAD'
  AND jsonb_typeof("config"->'maxFileSizeMB') = 'number'
  AND ("config"->>'maxFileSizeMB')::numeric > 25;

UPDATE "QuestionBankItem"
SET "config" = jsonb_set("config", '{maxFileSizeMB}', '25')
WHERE "type" = 'FILE_UPLOAD'
  AND jsonb_typeof("config"->'maxFileSizeMB') = 'number'
  AND ("config"->>'maxFileSizeMB')::numeric > 25;
