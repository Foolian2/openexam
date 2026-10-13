import type { FileUploadConfig } from "@/lib/types/questions"

// Hard ceiling per uploaded file. Files live in Postgres (AnswerFile), so
// every byte also lands in pg_dump and in each retained wal-g base backup;
// question configs above this are clamped, not rejected, so older exports
// still import.
export const MAX_UPLOAD_MB = 25

/** The per-file limit actually enforced for a question: its config, capped. */
export function effectiveMaxFileSizeMB(config: Pick<FileUploadConfig, "maxFileSizeMB">): number {
  return Math.min(config.maxFileSizeMB, MAX_UPLOAD_MB)
}

// Per-session budget: twice the exam's FILE_UPLOAD capacity (one full
// re-upload set) but never below 512 MB. A single session can therefore
// never push more than this into the database, regardless of retries.
export const UPLOAD_MIN_BUDGET_BYTES = 512 * 1024 * 1024

// The budget window resets once the exam and its uploads are long done.
export const UPLOAD_BUDGET_TTL_SECONDS = 48 * 3600

export function computeUploadBudgetBytes(
  uploadQuestions: FileUploadConfig[]
): number {
  const capacityBytes = uploadQuestions.reduce(
    (sum, c) =>
      sum + (typeof c.maxFileSizeMB === "number" ? effectiveMaxFileSizeMB(c) * 1024 * 1024 : 0),
    0
  )
  return Math.max(UPLOAD_MIN_BUDGET_BYTES, capacityBytes * 2)
}
