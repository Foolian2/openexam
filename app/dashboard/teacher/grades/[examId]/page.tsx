import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { Download, ListChecks, Printer } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import type { Prisma } from "@/generated/prisma/client"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@/components/ui/button"
import { ExamStatusBadge } from "@/components/exams/exam-status-badge"
import { ResultsVisibilityControl } from "@/components/exams/results-visibility-control"
import { MarkGradedButton } from "@/components/grading/mark-graded-button"
import { GradesTable } from "@/components/grading/grades-table"
import { loadGradesSearchParams } from "@/lib/search-params/grades"
import { SUBMITTED_STATUSES } from "@/lib/session-state"

export const metadata: Metadata = {
  title: "Bewertung — OpenExam",
}

type Params = { params: Promise<{ examId: string }> }
type SearchParams = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const LIMIT = 25

export default async function ExamGradesPage({
  params,
  searchParams,
}: Params & SearchParams) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const { examId } = await params
  const { page } = await loadGradesSearchParams(searchParams)

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      _count: { select: { questions: true } },
      questions: { select: { points: true } },
    },
  })
  if (!exam || exam.creatorId !== session.user.id) notFound()
  // The exam total, like the CSV export, the PDFs and the student dashboard.
  // Summing only the existing grade rows made the maximum grow as grading
  // progressed ("8 / 14", then "8 / 18" for a 21-point exam).
  const examMaxPoints = exam.questions.reduce((sum, q) => sum + q.points, 0)

  await regradeFlaggedSessions({ examId })
  const where: Prisma.ExamSessionWhereInput = {
    examId,
    status: { in: SUBMITTED_STATUSES },
  }
  const [sessions, total] = await Promise.all([
    prisma.examSession.findMany({
      where,
      include: {
        user: { select: { name: true, email: true } },
        grades: { select: { points: true } },
      },
      orderBy: { user: { name: "asc" } },
      skip: (page - 1) * LIMIT,
      take: LIMIT,
    }),
    prisma.examSession.count({ where }),
  ])

  // Submissions with an ungraded question, across all pages, so the
  // mark-graded dialog can warn before students see a total without them.
  const incompleteCount =
    exam.status === "CLOSED"
      ? total -
        (
          await prisma.grade.groupBy({
            by: ["sessionId"],
            where: { session: where },
            _count: { _all: true },
          })
        ).filter((g) => g._count._all >= exam._count.questions).length
      : 0

  const rows = sessions.map((s) => ({
    id: s.id,
    submissionType: s.submissionType,
    user: s.user,
    totalPoints: s.grades.reduce((sum, g) => sum + g.points, 0),
    maxPoints: examMaxPoints,
    gradedCount: s.grades.length,
  }))

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title={exam.title}
        backHref="/dashboard/teacher/grades"
        backLabel="Zurück zur Prüfungsauswahl"
        description={
          <>
            <ExamStatusBadge status={exam.status} />
            <span className="ml-2">
              {total} Abgabe{total === 1 ? "" : "n"}
            </span>
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link href={`/dashboard/teacher/grades/${examId}/by-question`}>
                <ListChecks className="h-4 w-4" />
                Nach Frage bewerten
              </Link>
            </Button>
            <Button asChild variant="outline">
              <a href={`/api/exams/${examId}/export`} download>
                <Download className="h-4 w-4" />
                CSV exportieren
              </a>
            </Button>
            <Button asChild variant="outline">
              <a
                href={`/api/exams/${examId}/print`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Printer className="h-4 w-4" />
                Als PDF drucken
              </a>
            </Button>
            {exam.status === "CLOSED" && (
              <MarkGradedButton
                examId={examId}
                showResults={exam.showResults}
                incompleteCount={incompleteCount}
                submittedCount={total}
              />
            )}
          </>
        }
      />

      {(exam.status === "CLOSED" ||
        exam.status === "GRADED" ||
        exam.status === "ARCHIVED") && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <p className="text-sm text-muted-foreground">
            Ergebnis-Sichtbarkeit für Schüler:innen:
          </p>
          <ResultsVisibilityControl
            examId={examId}
            initialShowResults={exam.showResults}
            examStatus={exam.status}
          />
        </div>
      )}

      <GradesTable
        examId={examId}
        examStatus={exam.status}
        questionCount={exam._count.questions}
        sessions={rows}
        limit={LIMIT}
        total={total}
      />
    </div>
  )
}
