import { prisma } from "@/lib/prisma"
import { Prisma } from "@/generated/prisma/client"
import { autoGrade } from "./auto-grade"
import type { QuestionType } from "@/lib/validators/question"
import type { AnswerContentInput } from "@/lib/validators/answer"

interface GradeWrite {
  questionId: string
  points: number
  maxPoints: number
}

/**
 * Auto-grades every objectively gradable question of a submitted session by
 * upserting Grade rows. Idempotent — safe to call again (e.g. idempotent
 * submit replays and post-commit retries, see lib/grading/grade-with-retry);
 * manually adjusted grades are not overwritten.
 *
 * Batched into two statements regardless of question count (previously one
 * $transaction per question — 2N sequential round trips inline on the
 * submit/close request path). Splitting into an update bucket and a create
 * bucket, computed from one upfront read, is safe against the same race the
 * old per-question gate protected against:
 *   - toUpdate rows are written via a single UPDATE ... WHERE "autoGraded" =
 *     true — that predicate is re-evaluated by Postgres at write time, so a
 *     grade that was flipped to manual between the read and the write is
 *     never clobbered (the row just doesn't match and is silently skipped).
 *   - toCreate rows are written via createMany({ skipDuplicates: true }) — if
 *     a manual grade was created concurrently for one of these questions
 *     (making the read stale), the unique (sessionId, questionId) constraint
 *     makes that insert a no-op instead of an error.
 */
export async function autoGradeSession(sessionId: string): Promise<void> {
  // Cleared before reading the answers, not after writing grades: if the
  // ws-backend flusher lands another late answer while this run is in
  // flight, it sets the flag again and the next safety-net pass regrades.
  const cleared = await prisma.examSession.updateMany({
    where: { id: sessionId, needsRegrade: true },
    data: { needsRegrade: false },
  })
  try {
    await gradeSession(sessionId)
  } catch (err) {
    // The grades this run was meant to replace are still stale, so hand
    // the flag back. Best-effort: if this write fails too, the caller's
    // retry (gradeWithRetry) is what's left.
    if (cleared.count > 0) {
      await prisma.examSession
        .updateMany({ where: { id: sessionId }, data: { needsRegrade: true } })
        .catch(() => {})
    }
    throw err
  }
}

async function gradeSession(sessionId: string): Promise<void> {
  const session = await prisma.examSession.findUnique({
    where: { id: sessionId },
    include: {
      answers: true,
      grades: { select: { questionId: true, autoGraded: true } },
      exam: { include: { questions: true } },
    },
  })
  if (!session) return

  const answersByQuestion = new Map(session.answers.map((a) => [a.questionId, a]))
  const gradedByQuestion = new Map(session.grades.map((g) => [g.questionId, g.autoGraded]))

  const toUpdate: GradeWrite[] = []
  const toCreate: GradeWrite[] = []

  for (const question of session.exam.questions) {
    const answer = answersByQuestion.get(question.id)
    const result = autoGrade(
      question.type as QuestionType,
      question.config,
      (answer?.content as unknown as AnswerContentInput) ?? null,
      question.points,
      { matchingSeed: `${sessionId}:${question.id}` }
    )
    if (!result) continue

    const existing = gradedByQuestion.get(question.id)
    const write: GradeWrite = { questionId: question.id, points: result.points, maxPoints: question.points }
    if (existing === undefined) toCreate.push(write)
    else if (existing === true) toUpdate.push(write)
    // existing === false → manually graded, leave untouched
  }

  if (toUpdate.length === 0 && toCreate.length === 0) return

  await prisma.$transaction([
    ...(toUpdate.length > 0
      ? [
          prisma.$executeRaw`
            UPDATE "Grade" AS g
            SET points = v.points, "maxPoints" = v."maxPoints", "autoGraded" = true
            FROM (VALUES ${Prisma.join(
              toUpdate.map((r) => Prisma.sql`(${r.questionId}::text, ${r.points}::float8, ${r.maxPoints}::float8)`)
            )}) AS v("questionId", points, "maxPoints")
            WHERE g."sessionId" = ${sessionId}
              AND g."questionId" = v."questionId"
              AND g."autoGraded" = true
          `,
        ]
      : []),
    ...(toCreate.length > 0
      ? [
          prisma.grade.createMany({
            data: toCreate.map((r) => ({
              sessionId,
              questionId: r.questionId,
              points: r.points,
              maxPoints: r.maxPoints,
              autoGraded: true,
            })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ])
}
