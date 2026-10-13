import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { AuditLogTable } from "@/components/audit/audit-log-table"
import { loadAuditSearchParams } from "@/lib/search-params/audit"
import {
  buildAdminAuditLogWhere,
  fetchAuditLogPage,
} from "@/lib/audit-log-query"

export const metadata: Metadata = {
  title: "Audit-Log (Admin) — OpenExam",
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AdminAuditLogPage({ searchParams }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "ADMIN") redirect("/unauthorized")

  const { page, action, userId, from, to, ip } =
    await loadAuditSearchParams(searchParams)
  const limit = 25

  const where = buildAdminAuditLogWhere({
    action,
    userId,
    from,
    to,
    ip,
  })

  const [{ logs, total }, users] = await Promise.all([
    fetchAuditLogPage(where, page, limit),
    prisma.user.findMany({
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ])

  const serializedLogs = logs.map((l) => ({
    ...l,
    timestamp: l.timestamp.toISOString(),
    metadata: l.metadata as Record<string, unknown> | null,
  }))

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <div>
          <h1 className="text-xl font-semibold">Audit-Log (Admin)</h1>
          <p className="text-sm text-muted-foreground">
            Alle protokollierten Aktionen im gesamten System — inklusive
            Benutzerverwaltung und Fragenbank
          </p>
        </div>
      </div>

      <AuditLogTable
        admin
        logs={serializedLogs}
        total={total}
        limit={limit}
        users={users}
      />
    </div>
  )
}
