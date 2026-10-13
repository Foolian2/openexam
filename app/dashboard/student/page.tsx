import type { Metadata } from "next"
import Link from "next/link"
import { BookOpen } from "lucide-react"
import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { JoinExamForm } from "@/components/exam-taking/join-exam-form"
import { Card, CardContent } from "@/components/ui/card"
import { isOpen, isSubmitted, isWaiting } from "@/lib/session-state"

export const metadata: Metadata = {
  title: "Schüler-Dashboard — OpenExam",
}

const STATUS_LABELS: Record<string, string> = {
  WAITING: "Im Warteraum",
  IN_PROGRESS: "Läuft",
  SUBMITTED: "Abgegeben",
  AUTO_SUBMITTED: "Automatisch abgegeben",
  LOCKED: "Gesperrt",
}

// "pending": exam still in progress, no result expected yet.
// "grading": submitted, but the exam hasn't been fully graded yet.
// "unpublished": graded, but the teacher hasn't released results yet.
// "visible": graded and released — the score can be shown.
type ResultState = "pending" | "grading" | "unpublished" | "visible"

type SessionRow = {
  id: string
  examId: string
  title: string
  statusLabel: string
  total: number
  max: number
  resultState: ResultState
  canContinue: boolean
}

// Shared between the desktop table and the mobile card list so the two
// render paths can't drift apart on when a result link or a continue
// button appears.
function SessionResult({ row }: { row: SessionRow }) {
  switch (row.resultState) {
    case "visible":
      return (
        <Link
          href={`/dashboard/student/results/${row.id}`}
          className="underline underline-offset-2 hover:text-foreground"
        >
          {row.total} / {row.max} Punkte
        </Link>
      )
    case "unpublished":
      return <span className="italic">Noch nicht freigegeben</span>
    case "grading":
      return <span className="italic">Wird noch bewertet</span>
    case "pending":
      return "—"
  }
}

function SessionContinueButton({ row }: { row: SessionRow }) {
  if (!row.canContinue) return null
  return (
    <Button asChild size="sm" variant="outline">
      <Link href={`/exam/${row.examId}/take`}>Fortsetzen</Link>
    </Button>
  )
}

export default async function StudentDashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")

  await regradeFlaggedSessions({ userId: session.user.id })
  const sessions = await prisma.examSession.findMany({
    where: { userId: session.user.id },
    include: {
      exam: {
        select: {
          id: true,
          title: true,
          status: true,
          showResults: true,
          questions: { select: { points: true } },
        },
      },
      grades: { select: { points: true, maxPoints: true } },
    },
    orderBy: { startedAt: "desc" },
    take: 20,
  })

  const rows = sessions.map((s) => {
    // /take sends a waiting student on to the waiting room.
    const canContinue =
      (isOpen(s.status) && s.exam.status === "ACTIVE") ||
      (isWaiting(s.status) && s.exam.status === "PUBLISHED")
    const total = s.grades.reduce((sum, g) => sum + g.points, 0)
    // Sum over all exam questions, not just graded ones —
    // otherwise a partially graded exam shows a misleading max.
    const max = s.exam.questions.reduce((sum, q) => sum + q.points, 0)
    const isGraded =
      s.grades.length > 0 &&
      (s.exam.status === "GRADED" || s.exam.status === "ARCHIVED")
    const resultState: ResultState = !isSubmitted(s.status)
      ? "pending"
      : !isGraded
        ? "grading"
        : !s.exam.showResults
          ? "unpublished"
          : "visible"
    return {
      id: s.id,
      examId: s.exam.id,
      title: s.exam.title,
      statusLabel: STATUS_LABELS[s.status] ?? s.status,
      total,
      max,
      resultState,
      canContinue,
    }
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Schüler-Dashboard"
        description={`Willkommen, ${session.user.name}.`}
      />
      <div className="flex justify-center py-6 sm:py-8">
        <JoinExamForm />
      </div>

      {sessions.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BookOpen />
            </EmptyMedia>
            <EmptyTitle>Noch keine Prüfungen</EmptyTitle>
            <EmptyDescription>
              Geben Sie oben den Zugangscode ein, um an einer Prüfung
              teilzunehmen.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Meine Prüfungen
          </h2>
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prüfung</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ergebnis</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.title}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{row.statusLabel}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <SessionResult row={row} />
                    </TableCell>
                    <TableCell className="text-right">
                      <SessionContinueButton row={row} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col gap-3 md:hidden">
            {rows.map((row) => (
              <Card key={row.id} size="sm">
                <CardContent className="flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm leading-snug font-medium">
                      {row.title}
                    </p>
                    <Badge variant="secondary">{row.statusLabel}</Badge>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-muted-foreground">
                      <SessionResult row={row} />
                    </p>
                    <SessionContinueButton row={row} />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
