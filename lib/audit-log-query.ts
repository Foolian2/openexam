import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { swissDayStart } from "@/lib/format-date"

export const AUDIT_LOG_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  metadata: true,
  ipAddress: true,
  userAgent: true,
  timestamp: true,
  user: { select: { id: true, name: true, email: true } },
  exam: { select: { id: true, title: true } },
} satisfies Prisma.AuditLogSelect

export type AuditLogItem = Prisma.AuditLogGetPayload<{
  select: typeof AUDIT_LOG_SELECT
}>

export interface AuditLogFilters {
  teacherId: string
  examId?: string
  action?: string
  from?: string
  to?: string
  userId?: string
  ip?: string
}

/** Shared date-range handling for both the teacher and admin where builders. */
function buildTimestampRange(
  from?: string,
  to?: string
): Prisma.DateTimeFilter {
  // The UI sends calendar days. "Bis 7.10." means through the end of that
  // day (it used to stop at its first second), and both bounds follow Swiss
  // days like the timestamps the table shows. Full timestamps from API
  // callers keep their exact meaning.
  const timestamp: Prisma.DateTimeFilter = {}
  const fromDate = from ? (swissDayStart(from) ?? new Date(from)) : null
  if (fromDate && !isNaN(fromDate.getTime())) timestamp.gte = fromDate
  if (to) {
    const nextDayStart = swissDayStart(nextDay(to))
    if (nextDayStart) {
      timestamp.lt = nextDayStart
    } else {
      const toDate = new Date(to)
      if (!isNaN(toDate.getTime())) timestamp.lte = toDate
    }
  }
  return timestamp
}

/** "2026-10-07" → "2026-10-08"; anything else is returned unchanged. */
function nextDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day
  const d = new Date(`${day}T12:00:00Z`)
  if (isNaN(d.getTime())) return day
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Scoped to exam-associated rows the caller owns: `examId != null AND
 * exam.creatorId = teacherId`. Folder-level actions (FOLDER_CREATED etc.,
 * which carry no examId) are deliberately out of scope for v1 — AuditLog has
 * no direct owner column, only the actor (userId), so including them would
 * need a second OR-branch joining Folder.creatorId instead of this single
 * clean where-clause.
 */
export function buildAuditLogWhere({
  teacherId,
  examId,
  action,
  from,
  to,
  userId,
  ip,
}: AuditLogFilters): Prisma.AuditLogWhereInput {
  const timestamp = buildTimestampRange(from, to)
  const ipFilter = ip?.trim()

  return {
    examId: examId ? examId : { not: null },
    exam: { creatorId: teacherId },
    ...(action ? { action } : {}),
    ...(userId ? { userId } : {}),
    ...(ipFilter
      ? { ipAddress: { contains: ipFilter, mode: "insensitive" as const } }
      : {}),
    ...(Object.keys(timestamp).length > 0 ? { timestamp } : {}),
  }
}

export interface AdminAuditLogFilters {
  action?: string
  from?: string
  to?: string
  userId?: string
  ip?: string
}

/**
 * Admin view: every row in the table (no owner scoping), with the same
 * action/date/actor/IP filters. This is what surfaces non-exam actions
 * (TEACHER_PROMOTE_*, USER_ROLE_CHANGED, QUESTION_BANK_ITEM_*) that the
 * exam-scoped teacher view deliberately hides.
 */
export function buildAdminAuditLogWhere({
  action,
  from,
  to,
  userId,
  ip,
}: AdminAuditLogFilters): Prisma.AuditLogWhereInput {
  const timestamp = buildTimestampRange(from, to)
  const ipFilter = ip?.trim()

  return {
    ...(action ? { action } : {}),
    ...(userId ? { userId } : {}),
    ...(ipFilter
      ? { ipAddress: { contains: ipFilter, mode: "insensitive" as const } }
      : {}),
    ...(Object.keys(timestamp).length > 0 ? { timestamp } : {}),
  }
}

export async function fetchAuditLogPage(
  where: Prisma.AuditLogWhereInput,
  page: number,
  limit: number
): Promise<{ logs: AuditLogItem[]; total: number }> {
  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      select: AUDIT_LOG_SELECT,
      orderBy: { timestamp: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ])
  return { logs, total }
}
