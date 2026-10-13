import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
import { AuditLogTable } from "@/components/audit/audit-log-table"
import { loadAuditSearchParams } from "@/lib/search-params/audit"
import { buildAuditLogWhere, fetchAuditLogPage } from "@/lib/audit-log-query"

export const metadata: Metadata = {
  title: "Audit-Log — OpenExam",
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function TeacherAuditLogPage({ searchParams }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN")
    redirect("/unauthorized")

  const { page, examId, action, userId, from, to, ip } =
    await loadAuditSearchParams(searchParams)
  const limit = 25

  const where = buildAuditLogWhere({
    teacherId: session.user.id,
    examId,
    action,
    userId,
    from,
    to,
    ip,
  })

  const [{ logs, total }, exams, actors] = await Promise.all([
    fetchAuditLogPage(where, page, limit),
    prisma.exam.findMany({
      where: { creatorId: session.user.id },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
    // Actors who have ever acted on the caller's exams — populates the
    // "Ausgeführt von" filter without exposing unrelated users.
    prisma.auditLog.findMany({
      where: {
        examId: { not: null },
        exam: { creatorId: session.user.id },
      },
      distinct: ["userId"],
      select: {
        userId: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
  ])

  const serializedLogs = logs.map((l) => ({
    ...l,
    timestamp: l.timestamp.toISOString(),
    metadata: l.metadata as Record<string, unknown> | null,
  }))

  const users = actors
    .filter((a): a is typeof a & { user: NonNullable<typeof a.user> } =>
      Boolean(a.user)
    )
    .map((a) => a.user)

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Audit-Log"
        description="Alle protokollierten Aktionen zu Ihren Prüfungen"
      />

      <AuditLogTable
        logs={serializedLogs}
        total={total}
        limit={limit}
        exams={exams}
        users={users}
      />
    </div>
  )
}
