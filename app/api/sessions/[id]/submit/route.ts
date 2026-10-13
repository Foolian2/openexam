import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@/generated/prisma/client"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { submitSessionSchema } from "@/lib/validators/session"
import { isSubmitted, OPEN_STATUSES, submitKind } from "@/lib/session-state"
import { verifySebAccess } from "@/lib/seb-guard"
import {
  activeDeviceWhere,
  getExamDeviceId,
  isActiveDevice,
} from "@/lib/exam-device"
import { publicRequestUrl } from "@/lib/seb-urls"
import { finalizeSession } from "@/lib/finalize-session"
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  sessionReplaced,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed
  const deviceId = getExamDeviceId(request.headers)

  // Idempotent (replay-safe via idempotencyKey), but should still not be
  // hammerable — fail closed like join-exam, since this finalizes a graded
  // submission.
  const limit = await rateLimit(
    `session-submit:${session.user.id}`,
    20,
    60,
    "closed"
  )
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const { id } = await params
  const body = await readBoundedJson(request, BODY_LIMITS.SMALL)
  if (body instanceof NextResponse) return body
  const parsed = submitSessionSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const { idempotencyKey, reason } = parsed.data

  const preSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: true },
  })
  if (!preSession || preSession.userId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  const guard = await verifySebAccess({
    exam: preSession.exam,
    examSession: preSession,
    headers: request.headers,
    requestUrl: publicRequestUrl(request),
    userId: session.user.id,
    ip: getClientIp(request) ?? undefined,
  })
  if (!guard.ok) {
    return forbidden("Safe Exam Browser erforderlich")
  }
  if (!isActiveDevice(preSession, session.session.id, deviceId)) {
    return sessionReplaced()
  }

  let outcome: "submitted" | "replay"
  let examId = ""
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const examSession = await tx.examSession.findUnique({ where: { id } })
      if (!examSession || examSession.userId !== session.user.id)
        throw new ApiError(404, "NOT_FOUND", "Sitzung nicht gefunden")
      examId = examSession.examId
      if (!isActiveDevice(examSession, session.session.id, deviceId)) {
        throw new ApiError(409, "SESSION_REPLACED", "Sitzung wurde übernommen")
      }

      if (isSubmitted(examSession.status)) {
        // Idempotent replay (e.g. client retry after a lost response).
        if (examSession.idempotencyKey === idempotencyKey) {
          const gate = await tx.examSession.updateMany({
            where: {
              id,
              status: examSession.status,
              ...activeDeviceWhere(session.session.id, deviceId),
            },
            data: { lastSeenAt: new Date() },
          })
          if (gate.count === 0) {
            const raced = await tx.examSession.findUnique({ where: { id } })
            if (raced && !isActiveDevice(raced, session.session.id, deviceId)) {
              throw new ApiError(
                409,
                "SESSION_REPLACED",
                "Sitzung wurde übernommen"
              )
            }
            throw new ApiError(
              409,
              "CONFLICT",
              "Prüfung wurde bereits abgegeben"
            )
          }
          return "replay"
        }
        throw new ApiError(409, "CONFLICT", "Prüfung wurde bereits abgegeben")
      }
      if (examSession.status === "LOCKED") {
        throw new ApiError(403, "FORBIDDEN", "Sitzung ist gesperrt")
      }

      const now = new Date()
      const kind = submitKind(
        examSession.effectiveEndTime,
        now,
        reason === "timeout"
      )
      // Atomic status guard: plain reads don't lock the row, so two concurrent
      // submits could both pass the checks above. The status condition makes
      // only one of them win; the loser is treated as a replay/conflict.
      const updated = await tx.examSession.updateMany({
        where: {
          id,
          status: { in: OPEN_STATUSES },
          ...activeDeviceWhere(session.session.id, deviceId),
        },
        data: {
          status: kind === "AUTO_TIME" ? "AUTO_SUBMITTED" : "SUBMITTED",
          submissionType: kind,
          submittedAt: now,
          idempotencyKey,
        },
      })
      if (updated.count === 0) {
        const raced = await tx.examSession.findUnique({ where: { id } })
        if (raced && !isActiveDevice(raced, session.session.id, deviceId)) {
          throw new ApiError(
            409,
            "SESSION_REPLACED",
            "Sitzung wurde übernommen"
          )
        }
        if (raced?.idempotencyKey === idempotencyKey) return "replay"
        throw new ApiError(409, "CONFLICT", "Prüfung wurde bereits abgegeben")
      }
      return "submitted"
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    // Defense in depth: idempotencyKey is no longer globally unique, but a
    // client retrying its own stored key against a row that already carries
    // it (e.g. a lost-response retry landing after another path already
    // wrote it) would otherwise surface as an uncaught 500 instead of the
    // conflict the status gate above already treats as a terminal reply.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return conflict("Prüfung wurde bereits abgegeben")
    }
    throw e
  }

  if (outcome === "submitted" || outcome === "replay") {
    // Replays regrade too: a crash between the commit and the grading call
    // (after the client's first attempt) must not leave the session
    // permanently ungraded — the retry is the only other caller the client
    // makes. finalizeSession grades idempotently (gated on autoGraded, never
    // throws), publishes the control message, then writes the audit log.
    await finalizeSession({
      examId,
      sessionIds: [id],
      control: { type: "SESSION_SUBMITTED", sessionId: id },
      // A replay re-runs finalization for crash recovery; the shared key keeps
      // it from writing a second audit row or re-publishing the control.
      dedupeKey: `SESSION_SUBMITTED:${id}`,
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: id,
        examId,
        userId: session.user.id,
        ipAddress: getClientIp(request) ?? undefined,
      },
    })
  }

  return NextResponse.json({ submitted: true, replay: outcome === "replay" })
}
