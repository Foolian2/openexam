export type MonitorAttentionReason =
  | "DISCONNECTED"
  | "LOCKED"
  | "SEB_INTEGRITY"
  | "DEVICE_REPLACED"
  | "INTEGRITY_EVENTS"
  | "LOW_TIME"

export type MonitorConnectionState = "LIVE" | "POLLING" | "STALE"

export interface MonitorAttentionSession {
  id: string
  status: string
  effectiveEndTime: string | null
  answerCount: number
  integrityEventCount: number
  sebIntegrityFlagged?: boolean
  deviceReplacedCount?: number
}

const OPEN_STATUSES = new Set(["IN_PROGRESS", "DISCONNECTED", "LOCKED"])

const ATTENTION_PRIORITY: Record<MonitorAttentionReason, number> = {
  DISCONNECTED: 500,
  LOCKED: 400,
  SEB_INTEGRITY: 300,
  DEVICE_REPLACED: 250,
  INTEGRITY_EVENTS: 200,
  LOW_TIME: 100,
}

const STALE_AFTER_MS = 45_000

export function getMonitorConnectionState({
  connected,
  lastUpdatedAt,
  nowMs,
}: {
  connected: boolean
  lastUpdatedAt: number | null
  nowMs: number
}): MonitorConnectionState {
  if (lastUpdatedAt === null || nowMs - lastUpdatedAt > STALE_AFTER_MS) {
    return "STALE"
  }
  return connected ? "LIVE" : "POLLING"
}

export function getMonitorAttentionReasons(
  session: MonitorAttentionSession,
  nowMs: number,
  questionCount: number
): MonitorAttentionReason[] {
  const reasons: MonitorAttentionReason[] = []

  if (session.status === "DISCONNECTED") reasons.push("DISCONNECTED")
  if (session.status === "LOCKED") reasons.push("LOCKED")
  if (session.sebIntegrityFlagged) reasons.push("SEB_INTEGRITY")
  if ((session.deviceReplacedCount ?? 0) > 0) reasons.push("DEVICE_REPLACED")
  if (session.integrityEventCount > 0) reasons.push("INTEGRITY_EVENTS")

  if (
    OPEN_STATUSES.has(session.status) &&
    session.effectiveEndTime &&
    session.answerCount < questionCount
  ) {
    const remainingMs = new Date(session.effectiveEndTime).getTime() - nowMs
    // An open session past its deadline (remainingMs negative) still needs
    // attention -- its automatic submission may be delayed or failed, and
    // it must stay flagged until its status becomes terminal.
    if (remainingMs <= 5 * 60_000) {
      reasons.push("LOW_TIME")
    }
  }

  return reasons
}

export function partitionMonitorSessions<
  Session extends MonitorAttentionSession,
>(
  sessions: Session[],
  nowMs: number,
  questionCount: number
): {
  attention: { session: Session; reasons: MonitorAttentionReason[] }[]
  rest: Session[]
} {
  const attention: {
    session: Session
    reasons: MonitorAttentionReason[]
  }[] = []
  const rest: Session[] = []

  for (const session of sessions) {
    const reasons = getMonitorAttentionReasons(session, nowMs, questionCount)
    if (reasons.length === 0) rest.push(session)
    else attention.push({ session, reasons })
  }

  attention.sort((a, b) => {
    const aScore = Math.max(
      ...a.reasons.map((reason) => ATTENTION_PRIORITY[reason])
    )
    const bScore = Math.max(
      ...b.reasons.map((reason) => ATTENTION_PRIORITY[reason])
    )
    return bScore - aScore
  })

  return { attention, rest }
}
