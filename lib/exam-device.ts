import { z } from "zod"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { redis } from "@/lib/redis"
import { createAuditLog } from "@/lib/audit"
import { ApiError } from "@/lib/api-response"
import { SOCKET_JOINABLE_STATUSES } from "@/lib/session-state"
import { logError } from "@/lib/logger"

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

// v4 only, matching lib/exam-tab.ts (crypto.randomUUID) and the WS backend's
// deviceIDPattern, so all three layers accept exactly the same shape.
const deviceIdSchema = z.uuidv4()

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
      // A request without a device header is only admitted while the row is
      // still unbound; once bound, the header must match.
      {
        OR:
          deviceId == null
            ? [{ activeDeviceId: null }]
            : [{ activeDeviceId: null }, { activeDeviceId: deviceId }],
      },
    ],
  }
}

type TxClient = Prisma.TransactionClient

interface DeviceGateParams {
  id: string
  authSessionId: string
  deviceId?: string | null
  /** Restrict the gate to these statuses; omit for any status. */
  status?: Prisma.ExamSessionWhereInput["status"]
  conflictMessage?: string
}

/**
 * After a device-gated updateMany matched zero rows, tells the takeover case
 * apart from the plain lifecycle case. Call inside the same transaction as
 * the gated update.
 */
export async function throwIfDeviceGateFailed(
  tx: TxClient,
  params: DeviceGateParams
): Promise<never> {
  const current = await tx.examSession.findUnique({
    where: { id: params.id },
    select: { activeAuthSessionId: true, activeDeviceId: true },
  })
  if (
    current &&
    !isActiveDevice(current, params.authSessionId, params.deviceId ?? null)
  ) {
    throw new ApiError(409, "SESSION_REPLACED", "Sitzung wurde übernommen")
  }
  throw new ApiError(
    409,
    "CONFLICT",
    params.conflictMessage ?? "Sitzung ist nicht aktiv"
  )
}

/**
 * Locks the session row with a device-gated updateMany (bumping lastSeenAt)
 * and throws SESSION_REPLACED/CONFLICT when it matched nothing. Every student
 * write route funnels through this so the gate and its failure triage exist
 * in exactly one place.
 */
export async function gateActiveDevice(
  tx: TxClient,
  params: DeviceGateParams
): Promise<void> {
  const gate = await tx.examSession.updateMany({
    where: {
      id: params.id,
      ...(params.status !== undefined ? { status: params.status } : {}),
      ...activeDeviceWhere(params.authSessionId, params.deviceId ?? null),
    },
    data: { lastSeenAt: new Date() },
  })
  if (gate.count === 0) await throwIfDeviceGateFailed(tx, params)
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
        claimVersion: true,
        status: true,
      },
    })
    if (!current || !SOCKET_JOINABLE_STATUSES.includes(current.status)) {
      throw new ApiError(409, "CONFLICT", "Sitzung ist nicht mehr aktiv")
    }
    const previous = current.activeAuthSessionId
    const previousDevice = current.activeDeviceId
    const previousCount = current.deviceReplacedCount
    const previousVersion = current.claimVersion
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
    // Both identities, the takeover count, the claim version and lifecycle
    // participate in the compare-and-swap. claimVersion bumps on EVERY claim,
    // including the initial binding, so WS sockets can order concurrent
    // registrations even when the takeover count is still zero.
    const newVersion = previousVersion + 1
    const { count } = await prisma.examSession.updateMany({
      where: {
        id: examSessionId,
        activeAuthSessionId: previous,
        activeDeviceId: previousDevice,
        deviceReplacedCount: previousCount,
        claimVersion: previousVersion,
        status: { in: SOCKET_JOINABLE_STATUSES },
      },
      data: {
        activeAuthSessionId: authSessionId,
        activeDeviceId: deviceId,
        claimVersion: { increment: 1 },
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
    try {
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
    } catch (err) {
      // The claim is already committed; a failed audit row must neither
      // turn a successful takeover into a 500 nor suppress the takeover
      // notification below.
      logError("SESSION_DEVICE_REPLACED audit write failed", {
        examSessionId,
        err,
      })
    }
    // Audit I/O can let a newer claim win. Do not publish an obsolete
    // owner; the version also lets sockets ignore an event delayed in transit.
    const settled = await prisma.examSession.findUnique({
      where: { id: examSessionId },
      select: {
        activeAuthSessionId: true,
        activeDeviceId: true,
        deviceReplacedCount: true,
        claimVersion: true,
      },
    })
    if (
      settled?.activeAuthSessionId !== authSessionId ||
      settled.activeDeviceId !== deviceId ||
      settled.deviceReplacedCount !== replacedCount ||
      settled.claimVersion !== newVersion
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
      replacedCount,
      newVersion
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
  count: number,
  claimVersion: number
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
        claimVersion,
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
