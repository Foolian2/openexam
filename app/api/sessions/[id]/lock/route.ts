import { NextRequest, NextResponse } from "next/server"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { redis } from "@/lib/redis"
import { lockSessionSchema } from "@/lib/validators/session"
import { readBoundedJson } from "@/lib/body-size"
import { OPEN_STATUSES } from "@/lib/session-state"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** Locks or unlocks a running session (locked students cannot save or submit). */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: { select: { creatorId: true, id: true, status: true } } },
  })
  if (!examSession || examSession.exam.creatorId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }

  if (examSession.exam.status !== "ACTIVE") {
    return conflict(
      "Nur aktive Prüfungen können gesperrt oder entsperrt werden"
    )
  }

  const body = await readBoundedJson(request, 1024)
  if (body instanceof NextResponse) return body

  const parsed = lockSessionSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const { locked } = parsed.data

  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      // Lock rows in the same order as exam-close workflows: parent Exam,
      // then ExamSession. A shared lock revalidates ownership/lifecycle and
      // prevents a close from crossing this transition.
      const liveExam = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT e.id
        FROM "Exam" e
        WHERE e.id = ${examSession.exam.id}
          AND e."creatorId" = ${session.user.id}
          AND e.status = 'ACTIVE'
        FOR SHARE OF e
      `
      if (liveExam.length !== 1) {
        throw new ApiError(409, "CONFLICT", "Prüfung ist nicht mehr aktiv")
      }

      const liveSession = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT es.id
        FROM "ExamSession" es
        WHERE es.id = ${id} AND es."examId" = ${examSession.exam.id}
        FOR UPDATE OF es
      `
      if (liveSession.length !== 1) {
        throw new ApiError(409, "CONFLICT", "Sitzung existiert nicht mehr")
      }

      // Use PostgreSQL's clock only after both row locks are held, so the
      // boundary cannot predate a lock wait. Go records receive time with its
      // process clock; comparisons rely on the application and DB clocks
      // being synchronized (as they are in the local compose deployment).
      const clockRows = await tx.$queryRaw<
        Array<{ transitionedAt: Date }>
      >`SELECT clock_timestamp() AS "transitionedAt"`
      const transitionedAt = clockRows[0]?.transitionedAt
      if (!transitionedAt)
        throw new Error("Database clock query returned no row")
      // Gate the write on the live status so two concurrent lock/unlock
      // requests can't both win a stale read-check.
      const gate = await tx.examSession.updateMany({
        where: {
          id,
          exam: { status: "ACTIVE" },
          status: locked ? { in: OPEN_STATUSES } : "LOCKED",
        },
        data: {
          status: locked ? "LOCKED" : "IN_PROGRESS",
          lockedAt: locked ? transitionedAt : null,
        },
      })
      if (gate.count === 0) {
        throw new ApiError(
          409,
          "CONFLICT",
          "Sitzung kann in diesem Zustand nicht geändert werden"
        )
      }
      if (locked) {
        await tx.sessionLockInterval.create({
          data: { sessionId: id, lockedAt: transitionedAt },
        })
      } else {
        const ended = await tx.sessionLockInterval.updateMany({
          where: { sessionId: id, unlockedAt: null },
          data: { unlockedAt: transitionedAt },
        })
        if (ended.count !== 1) {
          throw new ApiError(
            409,
            "CONFLICT",
            "Sperrverlauf der Sitzung ist inkonsistent"
          )
        }
      }
      return tx.examSession.findUniqueOrThrow({ where: { id } })
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    throw e
  }

  try {
    await redis.publish(
      `exam:${examSession.exam.id}:control`,
      JSON.stringify({
        type: locked ? "SESSION_LOCKED" : "SESSION_UNLOCKED",
        sessionId: id,
      })
    )
  } catch {
    // Non-fatal: WebSocket server may not be running in dev
  }

  await createAuditLog({
    action: locked ? "SESSION_LOCKED" : "SESSION_UNLOCKED",
    entityType: "ExamSession",
    entityId: id,
    examId: examSession.exam.id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({
    session: { id: updated.id, status: updated.status },
  })
}
