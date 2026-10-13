import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { BarChart2, ClipboardCheck } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
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
import { ExamStatusBadge } from "@/components/exams/exam-status-badge"
import { SUBMITTED_STATUSES } from "@/lib/session-state"
import { GradeStatusTabs } from "@/components/grading/grade-status-tabs"

export const metadata: Metadata = {
  title: "Bewertungen — OpenExam",
}

const GRADEABLE_STATUSES = ["CLOSED", "GRADED", "ARCHIVED"] as const

type GradeableStatus = (typeof GRADEABLE_STATUSES)[number]

// One message per tab — a filtered view that comes up empty means "nothing
// in this state", not "no submissions at all".
const STATUS_EMPTY: Record<
  GradeableStatus,
  { title: string; description: string }
> = {
  CLOSED: {
    title: "Nichts zu bewerten",
    description:
      "Keine beendete Prüfung wartet auf eine Bewertung. Beendete Prüfungen erscheinen hier automatisch.",
  },
  GRADED: {
    title: "Noch nichts bewertet",
    description:
      "Sobald Sie eine Prüfung vollständig bewertet und freigegeben haben, erscheint sie hier.",
  },
  ARCHIVED: {
    title: "Keine archivierten Prüfungen",
    description:
      "Archivierte Prüfungen sammeln sich hier, sobald Sie bewertete Prüfungen archivieren.",
  },
}

export default async function GradesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status } = await searchParams
  const statusFilter = GRADEABLE_STATUSES.includes(status as GradeableStatus)
    ? (status as GradeableStatus)
    : null
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const exams = await prisma.exam.findMany({
    where: {
      creatorId: session.user.id,
      status: { in: statusFilter ? [statusFilter] : [...GRADEABLE_STATUSES] },
    },
    include: {
      _count: { select: { questions: true } },
      sessions: {
        where: { status: { in: SUBMITTED_STATUSES } },
        select: { _count: { select: { grades: true } } },
      },
    },
    orderBy: { closedAt: "desc" },
    take: 50,
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Bewertungen"
        description="Verwalten Sie die Abgaben Ihrer Prüfungen."
      />

      <GradeStatusTabs current={status ?? "ALL"} />

      {exams.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart2 />
            </EmptyMedia>
            <EmptyTitle>
              {statusFilter
                ? STATUS_EMPTY[statusFilter].title
                : "Noch keine Abgaben"}
            </EmptyTitle>
            <EmptyDescription>
              {statusFilter
                ? STATUS_EMPTY[statusFilter].description
                : "Sobald Schüler:innen eine Prüfung abschliessen, erscheinen hier die Ergebnisse."}
            </EmptyDescription>
          </EmptyHeader>
          <Button asChild size="sm" variant="outline">
            <Link
              href={
                statusFilter
                  ? "/dashboard/teacher/grades"
                  : "/dashboard/teacher"
              }
            >
              {statusFilter
                ? "Alle Prüfungen anzeigen"
                : "Zur Prüfungsverwaltung"}
            </Link>
          </Button>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prüfung</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Abgaben</TableHead>
                <TableHead>Vollständig bewertet</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.map((exam) => {
                const fullyGraded = exam.sessions.filter(
                  (s) => s._count.grades >= exam._count.questions
                ).length
                return (
                  <TableRow key={exam.id}>
                    <TableCell className="font-medium">{exam.title}</TableCell>
                    <TableCell>
                      <ExamStatusBadge status={exam.status} />
                    </TableCell>
                    <TableCell>{exam.sessions.length}</TableCell>
                    <TableCell className="tabular-nums">
                      {fullyGraded} / {exam.sessions.length}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/dashboard/teacher/grades/${exam.id}`}>
                          <ClipboardCheck className="h-4 w-4" />
                          Bewerten
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
