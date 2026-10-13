import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
import { QuestionsOverviewTable } from "@/components/grading/questions-overview-table"
import { SUBMITTED_STATUSES } from "@/lib/session-state"

export const metadata: Metadata = {
  title: "Bewertung nach Frage — OpenExam",
}

type Params = { params: Promise<{ examId: string }> }

export default async function ExamGradesByQuestionPage({ params }: Params) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const { examId } = await params
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: { questions: { orderBy: { order: "asc" } } },
  })
  if (!exam || exam.creatorId !== session.user.id) notFound()

  const totalSessions = await prisma.examSession.count({
    where: { examId, status: { in: SUBMITTED_STATUSES } },
  })

  const questionIds = exam.questions.map((q) => q.id)
  const [gradedCounts, reviewedCounts] = await Promise.all([
    prisma.grade.groupBy({
      by: ["questionId"],
      where: { questionId: { in: questionIds } },
      _count: { _all: true },
    }),
    prisma.grade.groupBy({
      by: ["questionId"],
      where: {
        questionId: { in: questionIds },
        autoGraded: true,
        reviewedAt: { not: null },
      },
      _count: { _all: true },
    }),
  ])
  const gradedByQuestion = new Map(
    gradedCounts.map((g) => [g.questionId, g._count._all])
  )
  const reviewedByQuestion = new Map(
    reviewedCounts.map((r) => [r.questionId, r._count._all])
  )

  const rows = exam.questions.map((q) => ({
    id: q.id,
    title: q.title,
    type: q.type,
    points: q.points,
    gradedCount: gradedByQuestion.get(q.id) ?? 0,
    reviewedCount: reviewedByQuestion.get(q.id) ?? 0,
  }))

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={exam.title}
        description={`Bewertung nach Frage · ${totalSessions} Abgabe${totalSessions === 1 ? "" : "n"}`}
        backHref={`/dashboard/teacher/grades/${examId}`}
        backLabel="Zurück zur Bewertungsübersicht"
      />

      <QuestionsOverviewTable
        examId={examId}
        totalSessions={totalSessions}
        questions={rows}
      />
    </div>
  )
}
