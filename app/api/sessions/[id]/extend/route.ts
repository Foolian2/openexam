import { NextRequest, NextResponse } from "next/server"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@/generated/prisma/client"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { redis } from "@/lib/redis"
import { extendSessionSchema } from "@/lib/validators/session"
import { readBoundedJson } from "@/lib/body-size"
import { extendEffectiveEndTime } from "@/lib/exam-session"
import { isSubmitted } from "@/lib/session-state"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Grants extra time on a session — either the standardized Nachteilsausgleich
 * (+15% of the exam time limit) or an arbitrary number of minutes (e.g. for
 * technical issues).
 */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: true },
  })
  if (!examSession || examSession.exam.creatorId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  if (isSubmitted(examSession.status)) {
    return conflict("Sitzung wurde bereits abgegeben")
  }

  const body = await readBoundedJson(request, 1024)
  if (body instanceof NextResponse) return body

  const parsed = extendSessionSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const extraMinutes =
    "mode" in parsed.data
      ? Math.ceil(examSession.exam.timeLimitMin * 0.15)
      : parsed.data.minutes
  const isNam = "mode" in parsed.data

  // Lock and recheck the session inside the write transaction. The initial
  // read above is for ownership and request calculation only; the sweeper or
  // submit path may make the session terminal before this transaction gets
  // the row lock.
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const [lockedSession] = await tx.$queryRaw<
        { status: string; namApplied: boolean }[]
      >(Prisma.sql`
        SELECT "status"::text AS "status", "namApplied"
        FROM "ExamSession"
        WHERE "id" = ${id}
        FOR UPDATE
      `)
      if (!lockedSession) {
        throw new ApiError(404, "NOT_FOUND", "Sitzung nicht gefunden")
      }
      if (isSubmitted(lockedSession.status)) {
        throw new ApiError(409, "CONFLICT", "Sitzung wurde bereits abgegeben")
      }

      if (isNam) {
        if (lockedSession.namApplied) {
          throw new ApiError(
            409,
            "CONFLICT",
            "Nachteilsausgleich wurde bereits gewährt"
          )
        }
        await tx.examSession.update({
          where: { id },
          data: { namApplied: true },
        })
      }
      const incremented = await tx.examSession.update({
        where: { id },
        data: { timeExtensionMin: { increment: extraMinutes } },
      })
      // Additive extension: push the existing deadline out by the granted
      // minutes. Recomputing from startedAt + the exam's CURRENT
      // timeLimitMin would drift if the teacher edits the exam's time limit
      // mid-exam (sessions started before an edit would inherit the new
      // limit retroactively). Pre-start grants just accumulate in
      // timeExtensionMin; the join route folds them into the end time.
      if (!incremented.effectiveEndTime) return incremented
      return tx.examSession.update({
        where: { id },
        data: {
          effectiveEndTime: extendEffectiveEndTime(
            incremented.effectiveEndTime,
            extraMinutes
          ),
        },
      })
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    throw e
  }

  try {
    await redis.publish(
      `exam:${examSession.examId}:control`,
      JSON.stringify({
        type: "SESSION_EXTENDED",
        sessionId: id,
        effectiveEndTime: updated.effectiveEndTime,
        timeExtensionMin: updated.timeExtensionMin,
        namApplied: updated.namApplied,
      })
    )
  } catch {
    // Non-fatal: WebSocket server may not be running in dev
  }

  await createAuditLog({
    action: "SESSION_EXTENDED",
    entityType: "ExamSession",
    entityId: id,
    examId: examSession.examId,
    userId: session.user.id,
    metadata: {
      extraMinutes,
      timeExtensionMin: updated.timeExtensionMin,
      reason: "mode" in parsed.data ? "NAM" : "MANUAL",
    },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({
    session: {
      id: updated.id,
      timeExtensionMin: updated.timeExtensionMin,
      effectiveEndTime: updated.effectiveEndTime,
      namApplied: updated.namApplied,
    },
  })
}
