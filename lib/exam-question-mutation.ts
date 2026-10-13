import { Prisma } from "@/generated/prisma/client"
import type { Prisma as PrismaTypes } from "@/generated/prisma/client"
import { ApiError } from "@/lib/api-response"

export const EDITABLE_EXAM_STATUSES = ["DRAFT", "PUBLISHED"] as const

export type LockedExam = {
  id: string
  creatorId: string
  status: string
  sebRequired: boolean
}

/** Acquires the serialization lock shared by activation and question writes. */
export async function lockExamRow(
  tx: PrismaTypes.TransactionClient,
  examId: string
): Promise<LockedExam | null> {
  const [exam] = await tx.$queryRaw<LockedExam[]>(Prisma.sql`
    SELECT "id", "creatorId", "status"::text AS "status", "sebRequired"
    FROM "Exam"
    WHERE "id" = ${examId}
    FOR UPDATE
  `)
  return exam ?? null
}

/** Locks all owner exams containing this bank item's copies in stable order. */
export async function lockExamsWithQuestionBankCopies(
  tx: PrismaTypes.TransactionClient,
  bankItemId: string,
  ownerId: string
): Promise<LockedExam[]> {
  return tx.$queryRaw<LockedExam[]>(Prisma.sql`
    SELECT e."id", e."creatorId", e."status"::text AS "status", e."sebRequired"
    FROM "Exam" e
    WHERE e."creatorId" = ${ownerId}
      AND EXISTS (
        SELECT 1
        FROM "Question" q
        WHERE q."examId" = e."id"
          AND q."bankItemId" = ${bankItemId}
      )
    ORDER BY e."id"
    FOR UPDATE
  `)
}

/** Locks the parent and rechecks its owner and editable state before writes. */
export async function lockEditableExamForQuestionMutation(
  tx: PrismaTypes.TransactionClient,
  examId: string,
  userId: string,
  conflictMessage: string
): Promise<LockedExam> {
  const exam = await lockExamRow(tx, examId)
  if (!exam || exam.creatorId !== userId) {
    throw new ApiError(404, "NOT_FOUND", "Prüfung nicht gefunden")
  }
  if (
    !EDITABLE_EXAM_STATUSES.includes(
      exam.status as (typeof EDITABLE_EXAM_STATUSES)[number]
    )
  ) {
    throw new ApiError(409, "CONFLICT", conflictMessage)
  }
  return exam
}
