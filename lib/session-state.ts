import type { SessionStatus } from "@/generated/prisma/client"

/**
 * Grace period after the effective end time during which late saves/submits
 * are still accepted. Lives here (not lib/exam-session) so the client-safe
 * status helpers don't drag the server-only exam-session module into browser
 * bundles.
 */
export const SUBMIT_GRACE_MS = 30_000

/**
 * The "open session" concept, named. These are the ExamSession statuses a
 * session may be resumed/joined in via the REST session routes (join,
 * autosave, submit, upload). A session in any other status is terminal for
 * answer mutation.
 */
export const OPEN_STATUSES: SessionStatus[] = ["IN_PROGRESS"]

/** Session statuses a WS connection may join in; LOCKED joins read-only so the unlock event still reaches the student. */
export const SOCKET_JOINABLE_STATUSES: SessionStatus[] = [
  "IN_PROGRESS",
  "LOCKED",
]

/**
 * A WAITING session (shared-start waiting room) is in none of these sets: it
 * cannot save, submit, connect a socket or be swept, and it has no deadline.
 */
export function isWaiting(status: string): boolean {
  return status === "WAITING"
}

/** Session statuses counted as live on the teacher dashboard and monitor. */
export const ACTIVE_STATUSES: SessionStatus[] = ["IN_PROGRESS", "LOCKED"]

/** Session statuses that are submitted (terminal): no further answer mutation or grading-time extension. */
export const SUBMITTED_STATUSES: SessionStatus[] = [
  "SUBMITTED",
  "AUTO_SUBMITTED",
]

/** Whether a session can be resumed/joined via the REST session routes. */
export function isOpen(status: string): boolean {
  return OPEN_STATUSES.includes(status as SessionStatus)
}

/** Whether a WS connection may join the session's exam room. */
export function isSocketJoinable(status: string): boolean {
  return SOCKET_JOINABLE_STATUSES.includes(status as SessionStatus)
}

/** Whether the session counts as live (teacher dashboard/monitor). */
export function isActive(status: string): boolean {
  return ACTIVE_STATUSES.includes(status as SessionStatus)
}

/** Whether the session has been submitted (terminal). */
export function isSubmitted(status: string): boolean {
  return SUBMITTED_STATUSES.includes(status as SessionStatus)
}

/**
 * What the student UI should do with a session, given its status and its
 * exam's. Shared by the initial load and the status poll so they agree.
 */
export type SessionGate = "LOCKED" | "COMPLETE" | "OPEN"

export function sessionGate(
  sessionStatus: string,
  examStatus: string
): SessionGate {
  // LOCKED is checked first and wins: a teacher-locked session shows the lock
  // dialog rather than navigating, whatever else is true of it.
  if (sessionStatus === "LOCKED") return "LOCKED"
  if (isSubmitted(sessionStatus) || examStatus !== "ACTIVE") return "COMPLETE"
  return "OPEN"
}

/**
 * Whether the effective end time plus the submit grace window has passed.
 * A `null` end time (deadline never set) is never past.
 */
export function pastDeadline(
  effectiveEndTime: Date | null,
  now: Date = new Date()
): boolean {
  return (
    effectiveEndTime !== null &&
    now.getTime() > effectiveEndTime.getTime() + SUBMIT_GRACE_MS
  )
}

/**
 * How long before the effective end time a submit the client marks as a
 * timer expiry still counts as one. The runner fires at 0:00 on its
 * server-offset clock, so the request can land a moment before the server's
 * deadline; the hint can only move the label within this window.
 */
export const TIMEOUT_SUBMIT_SKEW_MS = 5_000

/**
 * The submission type a student-initiated submit is recorded as.
 *
 * AUTO_TIME once the deadline is reached, not only after the grace window:
 * the runner submits at 0:00 and that request always lands inside the grace,
 * so keying the label on pastDeadline() recorded every "time ran out" as
 * MANUAL ("Manuell" in the grades table). The grace still decides whether a
 * save or submit is accepted at all; it no longer decides the label.
 */
export function submitKind(
  effectiveEndTime: Date | null,
  now: Date,
  timerExpired: boolean
): "AUTO_TIME" | "MANUAL" {
  if (effectiveEndTime === null) return "MANUAL"
  const skew = timerExpired ? TIMEOUT_SUBMIT_SKEW_MS : 0
  return now.getTime() >= effectiveEndTime.getTime() - skew
    ? "AUTO_TIME"
    : "MANUAL"
}
