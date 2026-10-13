import { prisma } from "@/lib/prisma"
import { createAuditLog } from "@/lib/audit"
import { SUBMITTED_STATUSES } from "@/lib/session-state"

export type BulkGradeAction =
  | { action: "ZERO_UNGRADED" }
  | {
      action: "SET_POINTS"
      questionId: string
      points: number
      feedback?: string
    }
  | { action: "MARK_REVIEWED"; questionId: string }

export type BulkGradeResult =
  | {
      ok: true
      sessionsAffected: number
      gradesCreated: number
      gradesUpdated?: number
    }
  | {
      ok: false
      reason:
        "not_found" | "not_closed" | "question_not_found" | "invalid_points"
    }

/**
 * `sessionIds` is filtered down to sessions that actually belong to this
 * exam and are submitted: the caller only ever sends rows it rendered from
 * this exam's grades table, but this filter is the authorization boundary,
 * not the caller's honesty.
 *
 * Gated to CLOSED exams for every action — matching MarkGradedButton's
 * status gate — since bulk-mutating sessions still in progress would be a
 * real hazard.
 */
export async function applyBulkGrade(params: {
  examId: string
  teacherId: string
  sessionIds: string[]
  action: BulkGradeAction
  ipAddress?: string
}): Promise<BulkGradeResult> {
  const exam = await prisma.exam.findUnique({
    where: { id: params.examId },
    include: { questions: { select: { id: true, points: true } } },
  })
  if (!exam || exam.creatorId !== params.teacherId)
    return { ok: false, reason: "not_found" }
  if (exam.status !== "CLOSED") return { ok: false, reason: "not_closed" }

  const sessions = await prisma.examSession.findMany({
    where: {
      id: { in: params.sessionIds },
      examId: params.examId,
      status: { in: SUBMITTED_STATUSES },
    },
    select: { id: true, grades: { select: { questionId: true } } },
  })

  if (params.action.action === "ZERO_UNGRADED") {
    const missing: {
      sessionId: string
      questionId: string
      maxPoints: number
    }[] = []
    for (const s of sessions) {
      const gradedQuestionIds = new Set(s.grades.map((g) => g.questionId))
      for (const q of exam.questions) {
        if (!gradedQuestionIds.has(q.id)) {
          missing.push({
            sessionId: s.id,
            questionId: q.id,
            maxPoints: q.points,
          })
        }
      }
    }

    let gradesCreated = 0
    if (missing.length > 0) {
      // Tracks the actual write result, not the pre-write `missing` intent:
      // skipDuplicates can silently drop a row created by a concurrent
      // auto-grade, so both the result and audit entry must use this count.
      const result = await prisma.grade.createMany({
        data: missing.map((m) => ({
          sessionId: m.sessionId,
          questionId: m.questionId,
          points: 0,
          maxPoints: m.maxPoints,
          autoGraded: false,
          gradedById: params.teacherId,
        })),
        skipDuplicates: true,
      })
      gradesCreated = result.count
    }

    // One audit row per bulk operation, not one per session — a 30-student
    // bulk-zero should read as a single event, not spam the audit log.
    await createAuditLog({
      action: "BULK_GRADE_APPLIED",
      entityType: "Exam",
      entityId: params.examId,
      examId: params.examId,
      userId: params.teacherId,
      metadata: {
        action: "ZERO_UNGRADED",
        sessionCount: sessions.length,
        gradesCreated,
      },
      ipAddress: params.ipAddress,
    })

    return { ok: true, sessionsAffected: sessions.length, gradesCreated }
  }

  if (params.action.action === "SET_POINTS") {
    const { questionId, points, feedback } = params.action
    const question = exam.questions.find((q) => q.id === questionId)
    if (!question) return { ok: false, reason: "question_not_found" }
    if (points > question.points) return { ok: false, reason: "invalid_points" }

    await prisma.$transaction(
      sessions.map((s) =>
        prisma.grade.upsert({
          where: { sessionId_questionId: { sessionId: s.id, questionId } },
          create: {
            sessionId: s.id,
            questionId,
            points,
            maxPoints: question.points,
            feedback,
            autoGraded: false,
            gradedById: params.teacherId,
          },
          update: {
            points,
            maxPoints: question.points,
            feedback,
            autoGraded: false,
            gradedById: params.teacherId,
            gradedAt: new Date(),
            // Deliberately does not touch reviewedAt/reviewedById — a manual
            // point override is a distinct signal from "I reviewed the
            // auto-grade as-is". gradedAt/gradedById already show the
            // override happened.
          },
        })
      )
    )

    await createAuditLog({
      action: "BULK_GRADE_APPLIED",
      entityType: "Exam",
      entityId: params.examId,
      examId: params.examId,
      userId: params.teacherId,
      metadata: {
        action: "SET_POINTS",
        questionId,
        points,
        sessionCount: sessions.length,
      },
      ipAddress: params.ipAddress,
    })

    return {
      ok: true,
      sessionsAffected: sessions.length,
      gradesCreated: 0,
      gradesUpdated: sessions.length,
    }
  }

  // MARK_REVIEWED
  const { questionId } = params.action
  const question = exam.questions.find((q) => q.id === questionId)
  if (!question) return { ok: false, reason: "question_not_found" }

  // Only touches rows that are autoGraded === true: a manually graded row
  // has no auto-grade to review in the first place, and silently marking
  // it reviewed would misrepresent what happened. This scoping is also what
  // makes the action safe with no confirmation dialog — it can never
  // overwrite points or feedback.
  const result = await prisma.grade.updateMany({
    where: {
      questionId,
      sessionId: { in: sessions.map((s) => s.id) },
      autoGraded: true,
    },
    data: { reviewedAt: new Date(), reviewedById: params.teacherId },
  })

  await createAuditLog({
    action: "BULK_GRADE_APPLIED",
    entityType: "Exam",
    entityId: params.examId,
    examId: params.examId,
    userId: params.teacherId,
    metadata: {
      action: "MARK_REVIEWED",
      questionId,
      sessionCount: sessions.length,
      rowsReviewed: result.count,
    },
    ipAddress: params.ipAddress,
  })

  return { ok: true, sessionsAffected: sessions.length, gradesCreated: 0 }
}
