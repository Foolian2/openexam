import { describe, expect, it } from "vitest"
import {
  scheduleGate,
  clampToSchedule,
  scheduledEndCap,
  waitingRoomOpen,
} from "@/lib/exam-schedule"

const start = new Date("2026-08-10T10:00:00Z")
const end = new Date("2026-08-10T12:00:00Z")

function exam(
  overrides: Partial<{
    scheduledStart: Date | null
    scheduledEnd: Date | null
  }> = {}
) {
  return { scheduledStart: start, scheduledEnd: end, ...overrides }
}

describe("scheduleGate", () => {
  it("allows a new join inside the window", () => {
    expect(scheduleGate(exam(), new Date("2026-08-10T11:00:00Z"))).toEqual({
      ok: true,
    })
  })

  it("allows a new join exactly at scheduledStart", () => {
    expect(scheduleGate(exam(), start)).toEqual({ ok: true })
  })

  it("allows a new join exactly at scheduledEnd", () => {
    expect(scheduleGate(exam(), end)).toEqual({ ok: true })
  })

  it("blocks a new join before scheduledStart", () => {
    expect(scheduleGate(exam(), new Date("2026-08-10T09:59:59Z"))).toEqual({
      ok: false,
      reason: "not_started",
    })
  })

  it("blocks a new join after scheduledEnd", () => {
    expect(scheduleGate(exam(), new Date("2026-08-10T12:00:01Z"))).toEqual({
      ok: false,
      reason: "ended",
    })
  })

  it("allows an existing session to resume outside the window", () => {
    expect(
      scheduleGate(exam(), new Date("2026-08-10T09:00:00Z"), {
        existingSession: true,
      })
    ).toEqual({
      ok: true,
    })
    expect(
      scheduleGate(exam(), new Date("2026-08-10T13:00:00Z"), {
        existingSession: true,
      })
    ).toEqual({
      ok: true,
    })
  })

  it("passes when no bounds are set", () => {
    const unscheduled = exam({ scheduledStart: null, scheduledEnd: null })
    expect(scheduleGate(unscheduled, new Date("2020-01-01T00:00:00Z"))).toEqual(
      { ok: true }
    )
    expect(scheduleGate(unscheduled, new Date("2099-01-01T00:00:00Z"))).toEqual(
      { ok: true }
    )
  })

  it("passes when only one bound is set", () => {
    expect(
      scheduleGate(
        exam({ scheduledStart: null }),
        new Date("2026-08-10T12:00:01Z")
      )
    ).toEqual({
      ok: false,
      reason: "ended",
    })
    expect(
      scheduleGate(
        exam({ scheduledEnd: null }),
        new Date("2026-08-10T09:59:59Z")
      )
    ).toEqual({
      ok: false,
      reason: "not_started",
    })
  })
})

describe("clampToSchedule", () => {
  // Mirrors real usage: effectiveEndTime = startedAt + timeLimit (+ any
  // extension), which is what gets clamped to the exam's scheduledEnd.

  it("passes the deadline through unchanged when joining right at scheduledStart", () => {
    // A student joining right at scheduledStart (10:00) with a 60-minute
    // limit ends at 11:00, well before scheduledEnd (12:00) — nothing to
    // clamp.
    const deadline = new Date("2026-08-10T11:00:00Z")
    expect(clampToSchedule(deadline, end)).toEqual(deadline)
  })

  it("passes the deadline through unchanged when joining mid-schedule and the normal duration still fits before scheduledEnd", () => {
    // Joined at 11:00 with a 30-minute limit -> 11:30, still before the
    // 12:00 scheduledEnd.
    const deadline = new Date("2026-08-10T11:30:00Z")
    expect(clampToSchedule(deadline, end)).toEqual(deadline)
  })

  it("clamps to scheduledEnd when the normal duration would extend past it", () => {
    // Joined at 11:45 with a 90-minute limit -> would naturally run to
    // 13:15, well past the 12:00 scheduledEnd -> clamp to 12:00.
    const wouldBeDeadline = new Date("2026-08-10T13:15:00Z")
    expect(clampToSchedule(wouldBeDeadline, end)).toEqual(end)
  })

  it("returns exactly scheduledEnd (not a moment after) when the computed deadline lands exactly on it", () => {
    const deadline = new Date("2026-08-10T12:00:00Z")
    expect(clampToSchedule(deadline, end)).toEqual(end)
  })

  it("does not clamp when there is no scheduledEnd at all", () => {
    const farDeadline = new Date("2099-01-01T00:00:00Z")
    expect(clampToSchedule(farDeadline, null)).toEqual(farDeadline)
  })
})

describe("shared start (waiting room)", () => {
  const exam = {
    status: "PUBLISHED",
    waitingRoom: true,
    scheduledStart: start,
    scheduledEnd: null,
  }

  it("opens the waiting room at scheduledStart, inclusive", () => {
    expect(waitingRoomOpen(exam, new Date("2026-08-10T09:59:59Z"))).toBe(false)
    expect(waitingRoomOpen(exam, start)).toBe(true)
  })

  it("is open at once when no scheduledStart is set", () => {
    expect(waitingRoomOpen({ ...exam, scheduledStart: null }, start)).toBe(true)
  })

  it("is closed once the exam is started, and for exams without it", () => {
    expect(waitingRoomOpen({ ...exam, status: "ACTIVE" }, start)).toBe(false)
    expect(waitingRoomOpen({ ...exam, waitingRoom: false }, start)).toBe(false)
  })

  it("ignores scheduledEnd: no join cut-off and no deadline cap", () => {
    const shared = { ...exam, scheduledEnd: end }
    expect(scheduledEndCap(shared)).toBeNull()
    expect(scheduleGate(shared, new Date("2026-08-10T13:00:00Z"))).toEqual({
      ok: true,
    })
    expect(scheduledEndCap({ ...shared, waitingRoom: false })).toEqual(end)
  })
})
