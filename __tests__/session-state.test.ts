import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  ACTIVE_STATUSES,
  isActive,
  isOpen,
  isSocketJoinable,
  isSubmitted,
  OPEN_STATUSES,
  pastDeadline,
  sessionGate,
  SOCKET_JOINABLE_STATUSES,
  SUBMITTED_STATUSES,
  SUBMIT_GRACE_MS,
  submitKind,
  TIMEOUT_SUBMIT_SKEW_MS,
} from "@/lib/session-state"

/**
 * The other half of ws-backend/main_test.go's TestStudentJoinAllowed (which
 * reads the same file): the fixture is the single source of truth for the
 * status memberships, so the TypeScript predicates and the Go handshake map
 * cannot drift apart without one of these two suites going red.
 */
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "testdata", "session-status-vectors.json"),
    "utf8"
  )
) as {
  submitGraceMs: number
  statuses: {
    status: string
    open: boolean
    socketJoinable: boolean
    active: boolean
    submitted: boolean
  }[]
}

describe("shared session-status vectors", () => {
  it("has vectors to check", () => {
    expect(fixture.statuses.length).toBeGreaterThan(0)
  })

  it("pins SUBMIT_GRACE_MS to the fixture", () => {
    expect(SUBMIT_GRACE_MS).toBe(fixture.submitGraceMs)
  })

  it.each(fixture.statuses)(
    "$status",
    ({ status, open, socketJoinable, active, submitted }) => {
      expect(isOpen(status)).toBe(open)
      expect(isSocketJoinable(status)).toBe(socketJoinable)
      expect(isActive(status)).toBe(active)
      expect(isSubmitted(status)).toBe(submitted)
    }
  )
})

describe("status membership arrays", () => {
  it("OPEN_STATUSES contains exactly the fixture's open statuses", () => {
    expect([...OPEN_STATUSES].sort()).toEqual(
      fixture.statuses
        .filter((s) => s.open)
        .map((s) => s.status)
        .sort()
    )
  })

  it("SOCKET_JOINABLE_STATUSES contains exactly the fixture's socket-joinable statuses", () => {
    expect([...SOCKET_JOINABLE_STATUSES].sort()).toEqual(
      fixture.statuses
        .filter((s) => s.socketJoinable)
        .map((s) => s.status)
        .sort()
    )
  })

  it("ACTIVE_STATUSES contains exactly the fixture's active statuses", () => {
    expect([...ACTIVE_STATUSES].sort()).toEqual(
      fixture.statuses
        .filter((s) => s.active)
        .map((s) => s.status)
        .sort()
    )
  })

  it("SUBMITTED_STATUSES contains exactly the fixture's submitted statuses", () => {
    expect([...SUBMITTED_STATUSES].sort()).toEqual(
      fixture.statuses
        .filter((s) => s.submitted)
        .map((s) => s.status)
        .sort()
    )
  })
})

describe("pastDeadline", () => {
  const deadline = new Date("2026-08-13T10:00:00Z")
  const at = (msFromDeadline: number) =>
    new Date(deadline.getTime() + msFromDeadline)

  it("is never past when no end time is set", () => {
    expect(pastDeadline(null, at(60_000))).toBe(false)
  })

  it("is false before the deadline", () => {
    expect(pastDeadline(deadline, at(-1_000))).toBe(false)
  })

  it("is false within the grace window after the deadline", () => {
    expect(pastDeadline(deadline, at(SUBMIT_GRACE_MS - 1))).toBe(false)
  })

  it("is true past the grace window", () => {
    expect(pastDeadline(deadline, at(SUBMIT_GRACE_MS + 1))).toBe(true)
  })
})

describe("submitKind", () => {
  const deadline = new Date("2026-08-13T10:00:00Z")
  const at = (msFromDeadline: number) =>
    new Date(deadline.getTime() + msFromDeadline)

  it("is MANUAL for a submit before the deadline", () => {
    expect(submitKind(deadline, at(-60_000), false)).toBe("MANUAL")
  })

  it("is AUTO_TIME for the runner's 0:00 submit inside the grace window", () => {
    // Regression: labelled by pastDeadline(), this was always MANUAL.
    expect(submitKind(deadline, at(800), true)).toBe("AUTO_TIME")
    expect(submitKind(deadline, at(SUBMIT_GRACE_MS - 1), false)).toBe(
      "AUTO_TIME"
    )
  })

  it("tolerates a timer submit landing just before the server deadline", () => {
    expect(submitKind(deadline, at(-1_000), true)).toBe("AUTO_TIME")
    expect(submitKind(deadline, at(-1_000), false)).toBe("MANUAL")
  })

  it("does not let the timeout hint relabel an early submit", () => {
    expect(submitKind(deadline, at(-TIMEOUT_SUBMIT_SKEW_MS - 1), true)).toBe(
      "MANUAL"
    )
  })

  it("is MANUAL when no end time is set", () => {
    expect(submitKind(null, at(0), true)).toBe("MANUAL")
  })
})

describe("sessionGate", () => {
  it("keeps a live session open", () => {
    expect(sessionGate("IN_PROGRESS", "ACTIVE")).toBe("OPEN")
  })

  it("locks a locked session", () => {
    expect(sessionGate("LOCKED", "ACTIVE")).toBe("LOCKED")
  })

  it("shows the lock rather than navigating when a locked exam is no longer active", () => {
    // LOCKED is checked first, so a teacher who locks and then closes still
    // gets the dialog on the student's screen instead of a silent redirect.
    expect(sessionGate("LOCKED", "CLOSED")).toBe("LOCKED")
  })

  for (const status of SUBMITTED_STATUSES) {
    it(`sends a ${status} session to the complete page`, () => {
      expect(sessionGate(status, "ACTIVE")).toBe("COMPLETE")
    })
  }

  for (const examStatus of [
    "DRAFT",
    "PUBLISHED",
    "CLOSED",
    "GRADED",
    "ARCHIVED",
  ]) {
    it(`sends an in-progress session to the complete page when the exam is ${examStatus}`, () => {
      // The student must not keep answering an exam that is no longer running,
      // even though their own session still reads IN_PROGRESS.
      expect(sessionGate("IN_PROGRESS", examStatus)).toBe("COMPLETE")
    })
  }
})
