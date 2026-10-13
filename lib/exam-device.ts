import { z } from "zod"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { redis } from "@/lib/redis"
import { createAuditLog } from "@/lib/audit"
import { ApiError } from "@/lib/api-response"
import { SOCKET_JOINABLE_STATUSES } from "@/lib/session-state"

/**
 * One active login and browser tab per exam session, newest claim wins.
 * Auth identifies the login; deviceId distinguishes tabs sharing its cookie.
 * A takeover is advisory, not proof of a second person (e.g. a SEB relaunch).
 * It only detects overlapping use, not account sharing without overlap.
 */
export interface DeviceBoundSession {
  activeAuthSessionId?: string | null
  activeDeviceId?: string | null
}

const deviceIdSchema = z.uuid()

export function getExamDeviceId(headers: Headers): string | null {
  const parsed = deviceIdSchema.safeParse(headers.get("x-openexam-device-id"))
  return parsed.success ? parsed.data : null
}

/** Legacy unclaimed rows remain usable; bound rows require both identities. */
export function isActiveDevice(
  examSession: DeviceBoundSession,
  authSessionId: string,
  deviceId?: string | null
): boolean {
  return (
    (!examSession.activeAuthSessionId ||
      examSession.activeAuthSessionId === authSessionId) &&
    (!examSession.activeDeviceId || examSession.activeDeviceId === deviceId)
  )
}

/** Include in the same gated update that locks the session before a write. */
export function activeDeviceWhere(
  authSessionId: string,
  deviceId?: string | null
): Prisma.ExamSessionWhereInput {
  return {
    AND: [
      {
        OR: [
          { activeAuthSessionId: null },
          { activeAuthSessionId: authSessionId },
        ],
      },
      { OR: [{ activeDeviceId: null }, { activeDeviceId: deviceId ?? null }] },
    ],
  }
}

export type ClaimResult =
  { replaced: false } | { replaced: true; count: number }
const MAX_CLAIM_ATTEMPTS = 3

export async function claimExamDevice(params: {
  examSessionId: string
  examId: string
  userId: string
  authSessionId: string
  deviceId: string
  ip?: string
  userAgent?: string
}): Promise<ClaimResult> {
  const { examSessionId, examId, authSessionId, deviceId } = params

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const current = await prisma.examSession.findUnique({
      where: { id: examSessionId },
      select: {
        activeAuthSessionId: true,
        activeDeviceId: true,
        deviceReplacedCount: true,
        status: true,
      },
    })
    if (!current || !SOCKET_JOINABLE_STATUSES.includes(current.status)) {
      throw new ApiError(409, "CONFLICT", "Sitzung ist nicht mehr aktiv")
    }
    const previous = current.activeAuthSessionId
    const previousDevice = current.activeDeviceId
    const previousCount = current.deviceReplacedCount
    if (previous === authSessionId && previousDevice === deviceId) {
      return { replaced: false }
    }
    // Adding a tab binding to a legacy row held by this login is not a
    // takeover. Replacing either an existing login or tab is.
    const replaced =
      previous !== null &&
      (previous !== authSessionId ||
        (previousDevice !== null && previousDevice !== deviceId))

    // This update locks the same row as each REST mutation's device gate.
    // Both identities and lifecycle participate in the compare-and-swap.
    const { count } = await prisma.examSession.updateMany({
      where: {
        id: examSessionId,
        activeAuthSessionId: previous,
        activeDeviceId: previousDevice,
        deviceReplacedCount: previousCount,
        status: { in: SOCKET_JOINABLE_STATUSES },
      },
      data: {
        activeAuthSessionId: authSessionId,
        activeDeviceId: deviceId,
        ...(replaced
          ? {
              deviceReplacedCount: { increment: 1 },
              deviceReplacedAt: new Date(),
            }
          : {}),
      },
    })
    if (count === 0) continue
    if (!replaced) return { replaced: false }

    const replacedCount = previousCount + 1
    await createAuditLog({
      action: "SESSION_DEVICE_REPLACED",
      entityType: "ExamSession",
      entityId: examSessionId,
      examId,
      userId: params.userId,
      // A new login (another browser, or a SEB relaunch) vs. another tab of
      // the same login: lets a teacher tell the two apart.
      metadata: {
        count: replacedCount,
        loginChanged: previous !== authSessionId,
        tabChanged: previousDevice !== deviceId,
      },
      ipAddress: params.ip,
      userAgent: params.userAgent,
    })
    // Audit I/O can let a newer claim win. Do not publish an obsolete
    // owner; the counter also lets sockets ignore an event delayed in transit.
    const settled = await prisma.examSession.findUnique({
      where: { id: examSessionId },
      select: {
        activeAuthSessionId: true,
        activeDeviceId: true,
        deviceReplacedCount: true,
      },
    })
    if (
      settled?.activeAuthSessionId !== authSessionId ||
      settled.activeDeviceId !== deviceId ||
      settled.deviceReplacedCount !== replacedCount
    ) {
      throw new ApiError(
        409,
        "SESSION_REPLACED",
        "Prüfung wurde inzwischen erneut übernommen."
      )
    }
    await publishTakeover(
      examId,
      examSessionId,
      authSessionId,
      deviceId,
      replacedCount
    )
    return { replaced: true, count: replacedCount }
  }
  // A lost claim must not tell the client it may reload as the owner.
  throw new ApiError(
    409,
    "SESSION_REPLACED",
    "Prüfung wurde inzwischen erneut übernommen. Bitte erneut versuchen."
  )
}

async function publishTakeover(
  examId: string,
  examSessionId: string,
  authSessionId: string,
  deviceId: string,
  count: number
): Promise<void> {
  // Notification is best-effort. REST writes and every WS answer save check
  // durable ownership independently, including when this event is missed.
  try {
    await redis.publish(
      `exam:${examId}:control`,
      JSON.stringify({
        type: "SESSION_REPLACED",
        sessionId: examSessionId,
        activeAuthSessionId: authSessionId,
        activeDeviceId: deviceId,
        deviceReplacedCount: count,
      })
    )
  } catch {
    // Ownership was persisted; the next save detects replacement.
  }
  try {
    await redis.publish(
      `exam:${examId}:monitor`,
      JSON.stringify({
        originId: "web",
        sessionId: examSessionId,
        patch: { deviceReplacedCount: count },
      })
    )
  } catch {
    // Monitors pick the durable count up on reconnect.
  }
}
