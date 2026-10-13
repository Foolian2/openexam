import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { ArrowLeft, FileQuestion, Printer } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { sanitizeQuestion } from "@/lib/exam-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { QuestionViewer } from "@/components/questions/viewer/question-viewer"

export const metadata: Metadata = {
  title: "Ergebnis — OpenExam",
}

type Params = { params: Promise<{ sessionId: string }> }

export default async function StudentResultPage({ params }: Params) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")

  const { sessionId } = await params
  await regradeFlaggedSessions({ id: sessionId, userId: session.user.id })
  const examSession = await prisma.examSession.findUnique({
    where: { id: sessionId },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      answers: true,
      grades: true,
    },
  })
  if (!examSession || examSession.userId !== session.user.id) notFound()

  const { exam } = examSession
  const resultsVisible =
    exam.showResults && (exam.status === "GRADED" || exam.status === "ARCHIVED")
  if (!resultsVisible) redirect("/dashboard/student")

  const answersByQuestion = new Map(
    examSession.answers.map((a) => [a.questionId, a.content])
  )
  const gradesByQuestion = new Map(
    examSession.grades.map((g) => [g.questionId, g])
  )
  const total = examSession.grades.reduce((sum, g) => sum + g.points, 0)
  const maxTotal = exam.questions.reduce((sum, q) => sum + q.points, 0)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <Button
        asChild
        variant="ghost"
        size="icon"
        aria-label="Zurück zum Dashboard"
      >
        <Link href="/dashboard/student">
          <ArrowLeft />
        </Link>
      </Button>
      <PageHeader
        title="Ergebnis"
        description={
          <span className="font-medium text-foreground">
            {total} / {maxTotal} Punkte
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/sessions/${sessionId}/print`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Printer className="h-4 w-4" />
              Als PDF herunterladen
            </a>
          </Button>
        }
      />

      {exam.questions.length === 0 && (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestion />
            </EmptyMedia>
            <EmptyTitle>Keine Fragen in dieser Prüfung</EmptyTitle>
            <EmptyDescription>
              Zu dieser Prüfung liegen keine Fragen und damit keine
              Einzelergebnisse vor.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {exam.questions.map((q, index) => {
        const grade = gradesByQuestion.get(q.id)
        const answer = answersByQuestion.get(q.id)
        // Same sanitization as during the exam — the config column holds solutions.
        const studentQuestion = sanitizeQuestion(q, `${sessionId}:${q.id}`)
        return (
          <Card key={q.id}>
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <CardTitle className="text-base leading-relaxed font-medium">
                <span className="mr-2 text-muted-foreground">{index + 1}.</span>
                {q.title}
              </CardTitle>
              <Badge
                variant={
                  grade && grade.points >= q.points ? "default" : "outline"
                }
              >
                {grade
                  ? `${grade.points} / ${q.points} P.`
                  : `— / ${q.points} P.`}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {answer ? (
                <QuestionViewer
                  question={studentQuestion}
                  answer={answer}
                  sessionId={sessionId}
                  readOnly
                />
              ) : (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  Keine Antwort abgegeben
                </p>
              )}
              {grade?.feedback && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm">
                  <span className="font-medium">Feedback:</span>{" "}
                  {grade.feedback}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
