import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { isSubmitted } from "@/lib/session-state"
import { toTeacherAnswerContent } from "@/lib/grading/teacher-answer-content"
import { conflict, notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Grading view for the owning teacher: unsanitized questions (incl.
 * solutions), the student's answers and existing grades. Read-only: the
 * client first calls POST /api/exams/[id]/ensure-graded to backfill a
 * session a crash left ungraded.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      user: { select: { id: true, name: true, email: true } },
      answers: true,
      grades: true,
    },
  })
  if (!examSession || examSession.exam.creatorId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  if (!isSubmitted(examSession.status)) {
    return conflict("Sitzung wurde noch nicht abgegeben")
  }

  return NextResponse.json({
    session: {
      id: examSession.id,
      status: examSession.status,
      submissionType: examSession.submissionType,
      startedAt: examSession.startedAt,
      submittedAt: examSession.submittedAt,
      timeExtensionMin: examSession.timeExtensionMin,
      // Surfaced at grading time so a client swap mid-exam is visible while
      // marking, not only to whoever happened to watch the live monitor.
      sebIntegrityFlaggedAt: examSession.sebIntegrityFlaggedAt,
      sebIntegrityReason: examSession.sebIntegrityReason,
    },
    student: examSession.user,
    exam: {
      id: examSession.exam.id,
      title: examSession.exam.title,
      status: examSession.exam.status,
    },
    questions: examSession.exam.questions,
    answers: examSession.answers.map((a) => ({
      questionId: a.questionId,
      content: toTeacherAnswerContent(
        a.content,
        examSession.exam.questions.find((q) => q.id === a.questionId),
        examSession.id
      ),
      updatedAt: a.updatedAt,
    })),
    grades: examSession.grades.map((g) => ({
      questionId: g.questionId,
      points: g.points,
      maxPoints: g.maxPoints,
      feedback: g.feedback,
      autoGraded: g.autoGraded,
    })),
  })
}
