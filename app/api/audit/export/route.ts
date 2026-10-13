import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { createAuditLog } from "@/lib/audit"
import {
  buildAdminAuditLogWhere,
  buildAuditLogWhere,
} from "@/lib/audit-log-query"
import { auditActionLabel } from "@/lib/audit-actions"
import { csvField } from "@/lib/csv"
import { rateLimited } from "@/lib/api-response"

// Cap on exported rows so one request can't OOM the server. Newest rows
// win (the page orders by timestamp desc too).
const MAX_ROWS = 50_000

/**
 * Audit rows carry attacker-controlled text (a student picks their own
 * User-Agent), so fields go through the shared encoder, which neutralises
 * spreadsheet formulas as well as quoting for RFC 4180.
 */
function csvEscape(value: string): string {
  return csvField(value, ",")
}

function toCsv(
  rows: {
    timestamp: Date
    action: string
    examTitle: string | null
    userName: string | null
    userEmail: string | null
    ipAddress: string | null
    userAgent: string | null
    metadata: unknown
  }[]
): string {
  const header = [
    "Zeitpunkt",
    "Aktion",
    "Prüfung",
    "Ausgeführt von",
    "E-Mail",
    "IP-Adresse",
    "User-Agent",
    "Details",
  ]
  const lines = rows.map((r) =>
    [
      r.timestamp.toISOString(),
      auditActionLabel(r.action),
      r.examTitle ?? "",
      r.userName ?? "",
      r.userEmail ?? "",
      r.ipAddress ?? "",
      r.userAgent ?? "",
      r.metadata === null || r.metadata === undefined
        ? ""
        : JSON.stringify(r.metadata),
    ]
      .map(csvEscape)
      .join(",")
  )
  // BOM: without it Excel reads the file as Windows-1252 and every umlaut
  // ("Prüfung", "geändert") comes out garbled. Same as the results export.
  return "\uFEFF" + [header.join(","), ...lines].join("\n")
}

/**
 * Exports the audit log as CSV. Role-scoped server-side exactly like the
 * pages: teachers get rows for their own exams, admins get everything. The
 * export itself is audit-logged (AUDIT_LOG_EXPORTED) so the trail can't be
 * quietly extracted.
 */
export async function GET(request: NextRequest) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  // This is the heaviest read path in the app (admin scope = the whole
  // table, up to MAX_ROWS, plus an audit write per call), so it gets a
  // rate limit like the other bulk endpoints.
  const limit = await rateLimit(`audit-export:${session.user.id}`, 10, 60)
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const params = request.nextUrl.searchParams
  const shared = {
    examId: params.get("examId") ?? undefined,
    action: params.get("action") ?? undefined,
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    userId: params.get("userId") ?? undefined,
    ip: params.get("ip") ?? undefined,
  }
  // The admin where-builder has no examId clause, so don't hand it one —
  // passing it would silently drop the filter. Split the filter sets
  // instead of sharing one shape across both roles.
  // An admin gets every row only from the admin dashboard (scope=admin);
  // from the teacher audit page the export matches the exam-scoped view.
  const adminScope =
    session.user.role === "ADMIN" && params.get("scope") === "admin"
  const where = adminScope
    ? buildAdminAuditLogWhere({
        action: shared.action,
        from: shared.from,
        to: shared.to,
        userId: shared.userId,
        ip: shared.ip,
      })
    : buildAuditLogWhere({ teacherId: session.user.id, ...shared })

  const logs = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: MAX_ROWS,
    select: {
      timestamp: true,
      action: true,
      ipAddress: true,
      userAgent: true,
      metadata: true,
      user: { select: { name: true, email: true } },
      exam: { select: { title: true } },
    },
  })

  const csv = toCsv(
    logs.map((l) => ({
      timestamp: l.timestamp,
      action: l.action,
      examTitle: l.exam?.title ?? null,
      userName: l.user?.name ?? null,
      userEmail: l.user?.email ?? null,
      ipAddress: l.ipAddress,
      userAgent: l.userAgent,
      metadata: l.metadata,
    }))
  )

  await createAuditLog({
    action: "AUDIT_LOG_EXPORTED",
    entityType: "AuditLog",
    entityId: "export",
    userId: session.user.id,
    metadata: {
      scope: adminScope ? "admin" : "teacher",
      rowCount: logs.length,
      filters: Object.fromEntries(
        Object.entries(
          adminScope
            ? {
                action: shared.action,
                from: shared.from,
                to: shared.to,
                userId: shared.userId,
                ip: shared.ip,
              }
            : shared
        ).filter(([, v]) => v !== undefined)
      ),
    },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${new Date()
        .toISOString()
        .slice(0, 10)}.csv"`,
      // Signal a partial export instead of silently handing over a capped
      // window of rows.
      ...(logs.length >= MAX_ROWS ? { "X-Truncated": "true" } : {}),
    },
  })
}
