import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { MonitorPlay } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
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
import { ExamStatusBadge } from "@/components/exams/exam-status-badge"

export const metadata: Metadata = {
  title: "Live-Monitor — OpenExam",
}

export default async function MonitorPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const exams = await prisma.exam.findMany({
    where: { creatorId: session.user.id, status: { in: ["ACTIVE", "CLOSED"] } },
    include: { _count: { select: { sessions: true } } },
    orderBy: [{ status: "asc" }, { activatedAt: "desc" }],
    take: 20,
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Live-Monitor"
        description="Überwachen Sie laufende Prüfungen in Echtzeit."
      />

      {exams.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MonitorPlay />
            </EmptyMedia>
            <EmptyTitle>Keine laufenden Prüfungen</EmptyTitle>
            <EmptyDescription>
              Sobald Sie eine Prüfung starten, erscheint sie hier — mit
              Fortschritt, Restzeit und Auffälligkeiten in Echtzeit.
            </EmptyDescription>
          </EmptyHeader>
          <Button asChild size="sm" variant="outline">
            <Link href="/dashboard/teacher">Zur Prüfungsverwaltung</Link>
          </Button>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prüfung</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Zugangscode</TableHead>
                <TableHead>Teilnehmende</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.map((exam) => (
                <TableRow key={exam.id}>
                  <TableCell className="font-medium">{exam.title}</TableCell>
                  <TableCell>
                    <ExamStatusBadge status={exam.status} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono">
                      {exam.accessCode}
                    </Badge>
                  </TableCell>
                  <TableCell>{exam._count.sessions}</TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/dashboard/teacher/monitor/${exam.id}`}>
                        <MonitorPlay className="h-4 w-4" />
                        Überwachen
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
