-- Enable trigram support so ILIKE '%term%' searches on Exam.title can use an index
-- instead of a full sequential/filter scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Exam_title_trgm_idx" ON "Exam" USING GIN ("title" gin_trgm_ops);
