import { describe, expect, it } from "vitest"
import {
  getMonitorConnectionState,
  getMonitorAttentionReasons,
  partitionMonitorSessions,
} from "@/lib/monitor-attention"

const NOW = new Date("2026-08-20T12:00:00.000Z").getTime()

function session(
  overrides: Partial<{
    id: string
    status: string
    effectiveEndTime: string | null
    answerCount: number
    integrityEventCount: number
    sebIntegrityFlagged: boolean
  }> = {}
) {
  return {
    id: "session-1",
    status: "IN_PROGRESS",
    effectiveEndTime: "2026-08-20T12:30:00.000Z",
    answerCount: 4,
    integrityEventCount: 0,
    sebIntegrityFlagged: false,
    ...overrides,
  }
}

describe("monitor attention queue", () => {
  it("prioritizes disconnected and locked sessions before integrity and low-time sessions", () => {
    const result = partitionMonitorSessions(
      [
        session({ id: "steady" }),
        session({
          id: "low-time",
          effectiveEndTime: "2026-08-20T12:04:00.000Z",
          answerCount: 2,
        }),
        session({ id: "integrity", integrityEventCount: 2 }),
        session({ id: "locked", status: "LOCKED" }),
        session({ id: "disconnected", status: "DISCONNECTED" }),
      ],
      NOW,
      5
    )

    expect(result.attention.map((item) => item.session.id)).toEqual([
      "disconnected",
      "locked",
      "integrity",
      "low-time",
    ])
    expect(result.rest.map((item) => item.id)).toEqual(["steady"])
  })

  it("does not flag low time after submission or when every question is answered", () => {
    expect(
      getMonitorAttentionReasons(
        session({
          status: "SUBMITTED",
          effectiveEndTime: "2026-08-20T12:01:00.000Z",
        }),
        NOW,
        5
      )
    ).toEqual([])

    expect(
      getMonitorAttentionReasons(
        session({
          effectiveEndTime: "2026-08-20T12:01:00.000Z",
          answerCount: 5,
        }),
        NOW,
        5
      )
    ).toEqual([])
  })

  it("keeps an overdue open session flagged as low time past its deadline", () => {
    expect(
      getMonitorAttentionReasons(
        session({
          effectiveEndTime: "2026-08-20T11:55:00.000Z",
          answerCount: 2,
        }),
        NOW,
        5
      )
    ).toEqual(["LOW_TIME"])
  })

  it("describes multiple simultaneous attention reasons without duplicating the session", () => {
    const result = partitionMonitorSessions(
      [
        session({
          id: "multi",
          status: "DISCONNECTED",
          integrityEventCount: 3,
          sebIntegrityFlagged: true,
        }),
      ],
      NOW,
      5
    )

    expect(result.attention).toHaveLength(1)
    expect(result.attention[0].reasons).toEqual([
      "DISCONNECTED",
      "SEB_INTEGRITY",
      "INTEGRITY_EVENTS",
    ])
  })
})

describe("monitor connection state", () => {
  it("distinguishes live updates, polling fallback, and stale data", () => {
    expect(
      getMonitorConnectionState({
        connected: true,
        lastUpdatedAt: NOW - 10_000,
        nowMs: NOW,
      })
    ).toBe("LIVE")

    expect(
      getMonitorConnectionState({
        connected: false,
        lastUpdatedAt: NOW - 10_000,
        nowMs: NOW,
      })
    ).toBe("POLLING")

    expect(
      getMonitorConnectionState({
        connected: true,
        lastUpdatedAt: NOW - 46_000,
        nowMs: NOW,
      })
    ).toBe("STALE")
  })
})
