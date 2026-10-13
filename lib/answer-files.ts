import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"

// FILE_UPLOAD answer bytes, stored in Postgres (the AnswerFile model; see its
// comment in prisma/schema.prisma). Keys come from buildFileKey and are
// re-validated with fileKeyBelongsTo by every caller; the session/question
// scoping in the queries below is a second guard, not the primary check.

export async function storeAnswerFile(
  key: string,
  sessionId: string,
  questionId: string,
  bytes: Uint8Array<ArrayBuffer>,
  db: Pick<Prisma.TransactionClient, "answerFile"> = prisma
): Promise<void> {
  await db.answerFile.create({
    data: {
      key,
      sessionId,
      questionId,
      sizeBytes: bytes.byteLength,
      data: bytes,
    },
  })
}

/** The file's bytes, or null if no file with this key exists for the session/question. */
export async function readAnswerFile(
  key: string,
  sessionId: string,
  questionId: string
): Promise<Uint8Array<ArrayBuffer> | null> {
  const row = await prisma.answerFile.findFirst({
    where: { key, sessionId, questionId },
    select: { data: true },
  })
  return row?.data ?? null
}

/**
 * Deletes one superseded file. Scoped to its own session and question, so
 * even a key that slipped past fileKeyBelongsTo cannot reach another
 * student's upload. Deleting a key that doesn't exist is a no-op.
 */
export async function deleteAnswerFile(
  key: string,
  sessionId: string,
  questionId: string
): Promise<void> {
  await prisma.answerFile.deleteMany({ where: { key, sessionId, questionId } })
}

/** Whether a file with this key exists for the session/question, without reading its bytes. */
export async function answerFileExists(
  key: string,
  sessionId: string,
  questionId: string
): Promise<boolean> {
  const row = await prisma.answerFile.findFirst({
    where: { key, sessionId, questionId },
    select: { key: true },
  })
  return row !== null
}
