import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@/generated/prisma/client"
import { redis } from "@/lib/redis"
import { createAuditLog } from "@/lib/audit"
import { getClientIp } from "@/lib/client-ip"
import { logError } from "@/lib/logger"
import { extendExamSessionsSchema } from "@/lib/validators/session"
import { ACTIVE_STATUSES } from "@/lib/session-state"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

type ExtendedSession = {
  id: string
  effectiveEndTime: Date | null
  timeExtensionMin: number
  namApplied: boolean
}

/** Grants the same manual extension to every currently active exam session. */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const { id: examId } = await params
  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = extendExamSessionsSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { creatorId: true, status: true },
  })
  if (!exam || exam.creatorId !== authed.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (exam.status !== "ACTIVE") {
    return conflict("Prüfung ist nicht aktiv")
  }

  let sessions: ExtendedSession[]
  try {
    sessions = await prisma.$transaction(async (tx) => {
      // Lock the exam row for the life of this transaction. The close
      // endpoint's gate (`updateMany` ACTIVE -> CLOSED) also writes this row,
      // so whichever transaction acquires the lock first runs to completion
      // before the other observes a consistent status — closing the window
      // where a close commits between the preflight check above and the
      // session writes below, which would otherwise let this endpoint still
      // extend sessions after the exam is CLOSED.
      const [lockedExam] = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
        SELECT "status" FROM "Exam" WHERE "id" = ${examId} FOR UPDATE
      `)
      if (!lockedExam || lockedExam.status !== "ACTIVE") {
        throw new ApiError(409, "CONFLICT", "Prüfung ist nicht aktiv")
      }

      // Single set-based UPDATE instead of a per-session loop: the old loop
      // did three sequential round trips per candidate session inside one
      // interactive transaction, so a large class could exceed Prisma's
      // transaction timeout and roll back the whole extension without
      // extending anyone. The WHERE clause is the same eligibility gate the
      // old per-row conditional update used, still re-evaluated by Postgres
      // at write time, so a session that submits or gets locked out
      // mid-flight is skipped rather than reopened.
      return await tx.$queryRaw<ExtendedSession[]>(Prisma.sql`
        UPDATE "ExamSession"
        SET "timeExtensionMin" = "timeExtensionMin" + ${parsed.data.minutes},
            "effectiveEndTime" = "effectiveEndTime" + (${parsed.data.minutes} * interval '1 minute')
        WHERE "examId" = ${examId}
          AND "status"::text IN (${Prisma.join(ACTIVE_STATUSES)})
          AND "effectiveEndTime" IS NOT NULL
        RETURNING "id", "effectiveEndTime", "timeExtensionMin", "namApplied"
      `)
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    throw e
  }

  const published = await Promise.allSettled(
    sessions.map((session) =>
      redis.publish(
        `exam:${examId}:control`,
        JSON.stringify({
          type: "SESSION_EXTENDED",
          sessionId: session.id,
          effectiveEndTime: session.effectiveEndTime,
          timeExtensionMin: session.timeExtensionMin,
          namApplied: session.namApplied,
        })
      )
    )
  )
  const publishFailures = published.filter(
    (r) => r.status === "rejected"
  ).length
  if (publishFailures > 0) {
    // Not fatal: a student who misses this push still gets the authoritative
    // effectiveEndTime from their next REST status poll (see
    // components/exam-taking/exam-runner.tsx), which reconciles the
    // countdown even without the WS notification.
    logError("SESSION_EXTENDED publish failed", {
      examId,
      channel: `exam:${examId}:control`,
      failed: publishFailures,
      sessions: sessions.length,
    })
  }
  await createAuditLog({
    action: "EXAM_TIME_EXTENDED",
    entityType: "Exam",
    entityId: examId,
    examId,
    userId: authed.user.id,
    metadata: {
      minutes: parsed.data.minutes,
      sessionsAffected: sessions.length,
    },
    ipAddress: getClientIp(request) ?? undefined,
  })
  return NextResponse.json({ sessionsAffected: sessions.length, sessions })
}
