import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { SUBMITTED_STATUSES } from "@/lib/session-state"
import { toTeacherAnswerContent } from "@/lib/grading/teacher-answer-content"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string; qId: string }> }

/**
 * Grading view for one question across every submitted session of an
 * exam — the by-question analog of /api/sessions/[id]/review. Unsanitized
 * question config (incl. solutions), each student's answer and grade.
 * Read-only: the client first calls POST /api/exams/[id]/ensure-graded to
 * backfill sessions a crash left ungraded.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id, qId } = await params
  const question = await prisma.question.findUnique({
    where: { id: qId },
    include: { exam: true },
  })
  if (
    !question ||
    question.examId !== id ||
    question.exam.creatorId !== session.user.id
  ) {
    return notFound("Frage nicht gefunden")
  }

  const sessions = await prisma.examSession.findMany({
    where: { examId: id, status: { in: SUBMITTED_STATUSES } },
    include: {
      user: { select: { id: true, name: true, email: true } },
      answers: { where: { questionId: qId } },
      grades: true,
    },
    orderBy: { user: { name: "asc" } },
  })

  return NextResponse.json({
    question: {
      id: question.id,
      type: question.type,
      title: question.title,
      points: question.points,
      config: question.config,
    },
    exam: {
      id: question.exam.id,
      title: question.exam.title,
      status: question.exam.status,
    },
    rows: sessions.map((s) => {
      const grade = s.grades.find((g) => g.questionId === qId)
      return {
        sessionId: s.id,
        student: s.user,
        answer: s.answers[0]
          ? toTeacherAnswerContent(s.answers[0].content, question, s.id)
          : null,
        grade: grade
          ? {
              points: grade.points,
              maxPoints: grade.maxPoints,
              feedback: grade.feedback,
              autoGraded: grade.autoGraded,
              reviewedAt: grade.reviewedAt,
            }
          : null,
      }
    }),
  })
}
