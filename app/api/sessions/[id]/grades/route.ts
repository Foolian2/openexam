import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { saveGradesSchema } from "@/lib/validators/grade"
import { isSubmitted } from "@/lib/session-state"
import { conflict, notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** Saves manual grades (points + feedback) for a submitted session. */
export async function PUT(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: {
      exam: { include: { questions: { select: { id: true, points: true } } } },
      grades: {
        select: {
          questionId: true,
          points: true,
          feedback: true,
          autoGraded: true,
        },
      },
    },
  })
  if (!examSession || examSession.exam.creatorId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  if (!isSubmitted(examSession.status)) {
    return conflict("Sitzung wurde noch nicht abgegeben")
  }

  const body = await readBoundedJson(request, BODY_LIMITS.LARGE)
  if (body instanceof NextResponse) return body
  const parsed = saveGradesSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const gradeQuestionIds = parsed.data.grades.map((g) => g.questionId)
  if (new Set(gradeQuestionIds).size !== gradeQuestionIds.length) {
    return validationError(
      "Doppelte Fragen-IDs in den Bewertungen sind nicht erlaubt"
    )
  }

  const questionById = new Map(examSession.exam.questions.map((q) => [q.id, q]))
  for (const grade of parsed.data.grades) {
    const question = questionById.get(grade.questionId)
    if (!question) {
      return validationError("Frage gehört nicht zu dieser Prüfung")
    }
    if (grade.points > question.points) {
      return validationError(
        `Punkte überschreiten das Maximum (${question.points})`
      )
    }
  }

  // The grader saves (and autosaves) every row on the page, not just the one
  // being edited. Rewriting an untouched auto-graded row would flip it to
  // autoGraded=false, and auto-grading only ever updates autoGraded rows — so
  // a later answer-key fix would silently stop regrading every question the
  // teacher merely looked at. Only rows whose points or feedback changed
  // become manual grades.
  const existingByQuestion = new Map(
    examSession.grades.map((g) => [g.questionId, g])
  )
  const changed = parsed.data.grades.filter((grade) => {
    const existing = existingByQuestion.get(grade.questionId)
    return !(
      existing?.autoGraded &&
      existing.points === grade.points &&
      // Nullish normalization, matching the client's (grade?.feedback ?? "")
      // draft init, so "" (a meaningful "clear feedback" value) and strings
      // like "0" are compared as-is instead of through falsy coercion.
      (existing.feedback ?? "") === (grade.feedback ?? "")
    )
  })

  await prisma.$transaction(
    changed.map((grade) =>
      prisma.grade.upsert({
        where: {
          sessionId_questionId: { sessionId: id, questionId: grade.questionId },
        },
        create: {
          sessionId: id,
          questionId: grade.questionId,
          points: grade.points,
          maxPoints: questionById.get(grade.questionId)!.points,
          feedback: grade.feedback,
          autoGraded: false,
          gradedById: session.user.id,
        },
        update: {
          points: grade.points,
          maxPoints: questionById.get(grade.questionId)!.points,
          feedback: grade.feedback,
          autoGraded: false,
          gradedById: session.user.id,
          gradedAt: new Date(),
        },
      })
    )
  )

  await createAuditLog({
    action: "SESSION_GRADED",
    entityType: "ExamSession",
    entityId: id,
    examId: examSession.examId,
    userId: session.user.id,
    metadata: { gradedQuestions: changed.length },
    ipAddress: getClientIp(request) ?? undefined,
  })

  const grades = await prisma.grade.findMany({ where: { sessionId: id } })
  return NextResponse.json({
    grades: grades.map((g) => ({
      questionId: g.questionId,
      points: g.points,
      maxPoints: g.maxPoints,
      feedback: g.feedback,
      autoGraded: g.autoGraded,
    })),
  })
}
