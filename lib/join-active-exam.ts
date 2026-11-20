import { randomInt } from "node:crypto"
import { prisma } from "@/lib/prisma"
import type { ExamSession } from "@/generated/prisma/client"

interface FirstJoin {
  examId: string
  userId: string
  status: "IN_PROGRESS"
  startedAt: Date | null
  effectiveEndTime: Date | null
  lastSeenAt: Date
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

/** One statement: preserve burst admission capacity while coordinating close. */
export async function joinActiveExam(
  create: FirstJoin
): Promise<ExamSession | null> {
  // Raw INSERT cannot use Prisma's client-generated cuid() default. Preserve
  // the 25-character CUID-compatible syntax used by session API validators,
  // with 124 bits of random entropy and no extra package dependency.
  const id =
    "c" +
    Array.from(
      { length: 24 },
      () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]
    ).join("")
  const [session] = await prisma.$queryRaw<ExamSession[]>`
    WITH active_exam AS (
      SELECT id FROM "Exam"
      WHERE id = ${create.examId} AND status = 'ACTIVE'
      FOR SHARE
    )
    INSERT INTO "ExamSession"
      (id, "examId", "userId", status, "startedAt", "effectiveEndTime", "lastSeenAt")
    SELECT ${id}, id, ${create.userId}, ${create.status}::"SessionStatus",
      ${create.startedAt}::timestamp, ${create.effectiveEndTime}::timestamp,
      ${create.lastSeenAt}::timestamp
    FROM active_exam
    ON CONFLICT ("examId", "userId") DO UPDATE
      SET "lastSeenAt" = EXCLUDED."lastSeenAt"
      WHERE "ExamSession".status = 'IN_PROGRESS'
    RETURNING *
  `
  return session ?? null
}
