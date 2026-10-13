import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { verifyOrigin } from "@/lib/csrf"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { isSocketJoinable } from "@/lib/session-state"
import { verifySebAccess } from "@/lib/seb-guard"
import { publicRequestUrl } from "@/lib/seb-urls"
import { claimExamDevice, getExamDeviceId } from "@/lib/exam-device"
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Claims the exam session for the caller's login (lib/exam-device.ts).
 *
 * Called by the exam runner once on mount and from its "Hier weiterarbeiten"
 * button, never from the status poll: a poll that claimed would let the
 * replaced device silently take the session back.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  // Every takeover is an audit row and a monitor broadcast; a mount plus the
  // odd button press needs only a few per minute. Keyed by exam session so
  // one session's reloads cannot exhaust the budget of another.
  const { id } = await params
  const limit = await rateLimit(
    `session-device:${session.user.id}:${id}`,
    20,
    60
  )
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: true },
  })
  if (!examSession || examSession.userId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  const ip = getClientIp(request) ?? undefined
  const guard = await verifySebAccess({
    exam: examSession.exam,
    examSession,
    headers: request.headers,
    requestUrl: publicRequestUrl(request),
    userId: session.user.id,
    ip,
  })
  if (!guard.ok) {
    return forbidden("Safe Exam Browser erforderlich")
  }
  if (!isSocketJoinable(examSession.status)) {
    return conflict("Sitzung ist nicht mehr aktiv")
  }

  const deviceId = getExamDeviceId(request.headers)
  if (!deviceId) return validationError("Ungültige Gerätekennung")

  try {
    const result = await claimExamDevice({
      examSessionId: examSession.id,
      examId: examSession.examId,
      userId: session.user.id,
      authSessionId: session.session.id,
      deviceId,
      ip,
      userAgent: request.headers.get("user-agent") ?? undefined,
    })
    return NextResponse.json({ replaced: result.replaced })
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse()
    throw error
  }
}
