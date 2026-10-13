export type ScheduleGateResult =
  { ok: true } | { ok: false; reason: "not_started" | "ended" }

export interface SchedulableExam {
  scheduledStart: Date | null
  scheduledEnd: Date | null
  /** Shared-start exam: `scheduledEnd` does not apply (see scheduledEndCap). */
  waitingRoom?: boolean
}

/**
 * How long after the teacher presses Start the shared clock begins. The
 * waiting room shows it as a countdown; it absorbs polling and network delay
 * so everyone sees the questions at the same moment, and lets clients spread
 * their navigation to /take over it instead of arriving as one burst.
 */
export const SHARED_START_LEAD_MS = 10_000

/**
 * Whether students may enter the waiting room of `exam` now: a shared-start
 * exam that is published (not yet started) and whose `scheduledStart`, if
 * any, has been reached. Inclusive, like scheduleGate.
 */
export function waitingRoomOpen(
  exam: SchedulableExam & { status: string },
  now: Date
): boolean {
  return (
    exam.waitingRoom === true &&
    exam.status === "PUBLISHED" &&
    (!exam.scheduledStart || now >= exam.scheduledStart)
  )
}

/**
 * The scheduled end that caps joins and deadlines. A shared-start exam has
 * none: everyone gets the full time limit from the teacher's Start, and late
 * joiners from their own join, so a fixed end would only cut that time.
 */
export function scheduledEndCap(exam: SchedulableExam): Date | null {
  return exam.waitingRoom ? null : exam.scheduledEnd
}

/**
 * Join-gate for scheduled exams.
 *
 * `scheduledStart` / `scheduledEnd` define the window in which NEW sessions
 * may be created. An existing session always passes: its personal deadline
 * (startedAt + timeLimit + extension) is what governs it, and reconnects or
 * a resumption after `scheduledEnd` must not be cut off by the join window.
 * With the join gate as the single choke point, every other student path
 * (take page, autosave, submit, WS) is covered transitively — sessions can
 * only come into existence through the gated join.
 *
 * Boundaries are inclusive on both ends: exactly at `scheduledStart` the
 * exam is open, exactly at `scheduledEnd` it is still joinable.
 */
export function scheduleGate(
  exam: SchedulableExam,
  now: Date,
  opts: { existingSession?: boolean } = {}
): ScheduleGateResult {
  if (opts.existingSession) return { ok: true }
  if (exam.scheduledStart && now < exam.scheduledStart)
    return { ok: false, reason: "not_started" }
  const end = scheduledEndCap(exam)
  if (end && now > end) return { ok: false, reason: "ended" }
  return { ok: true }
}

/**
 * Hard cap on a session's personal deadline: never past the exam's
 * scheduled end.
 *
 * The join gate alone would let a student who joins at the very end of the
 * window (say 09:59:59 with a 90-minute time limit) work until 11:29:59 —
 * the full time limit *past* the scheduled end. When the school treats
 * `scheduledEnd` as "the exam is over at X" (room availability, fairness
 * against classmates who were auto-submitted at their personal deadlines),
 * the deadline must be clamped so nobody outlives the schedule.
 *
 * Teacher-initiated extensions (the extend route) are not clamped: they are
 * explicit, audited grants that may push a session past the scheduled end.
 */
export function clampToSchedule(
  effectiveEndTime: Date,
  scheduledEnd: Date | null
): Date {
  if (!scheduledEnd) return effectiveEndTime
  return effectiveEndTime > scheduledEnd ? scheduledEnd : effectiveEndTime
}
