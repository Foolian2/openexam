import * as Sentry from "@sentry/nextjs"
import { Prisma } from "@/generated/prisma/client"
import { prisma } from "./prisma"
import { logError } from "./logger"
import { auditLogWriteFailures } from "./metrics"

type AuditLogParams = Pick<
  Prisma.AuditLogUncheckedCreateInput,
  | "action"
  | "entityType"
  | "entityId"
  | "userId"
  | "examId"
  | "metadata"
  | "ipAddress"
  | "userAgent"
  | "idempotencyKey"
>

export async function createAuditLog(params: AuditLogParams): Promise<void> {
  try {
    if (params.idempotencyKey) {
      // A retried event (finalization recovery, submit replay) carries the
      // same key; ON CONFLICT DO NOTHING makes the retry a no-op.
      await prisma.auditLog.createMany({
        data: [params],
        skipDuplicates: true,
      })
      return
    }
    await prisma.auditLog.create({ data: params })
  } catch (err) {
    // Log the full event (not just the action) so it's recoverable from
    // container/log-aggregator output if the DB write is what failed. Also
    // report to GlitchTip: a lost audit entry is exactly the kind of event
    // that should page someone, not just sit in stdout.
    logError("Audit log write failed", { params, err })
    Sentry.captureException(err, { extra: { params } })
    auditLogWriteFailures.inc()
  }
}
