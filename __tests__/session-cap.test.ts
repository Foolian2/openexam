import { describe, expect, it } from "vitest"
import {
  capSessionRefresh,
  clampSessionSnapshot,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
} from "@/lib/session-cap"

const DAY = 24 * 60 * 60 * 1000
const now = new Date("2026-10-06T12:00:00Z")
const ago = (days: number) => new Date(now.getTime() - days * DAY)
const ahead = (days: number) => new Date(now.getTime() + days * DAY)

describe("capSessionRefresh", () => {
  it("is 30 days", () => {
    expect(SESSION_ABSOLUTE_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60)
  })

  it("leaves a young session's sliding refresh unchanged", () => {
    expect(capSessionRefresh({ expiresAt: ahead(7) }, ago(3), now)).toBe(
      undefined
    )
  })

  it("clamps a refresh that would overshoot the absolute cap", () => {
    const result = capSessionRefresh(
      { expiresAt: ahead(7), updatedAt: now },
      ago(27),
      now
    )
    expect(result).toEqual({
      data: { expiresAt: ahead(3), updatedAt: now },
    })
  })

  it("refuses the refresh once the cap has passed", () => {
    expect(capSessionRefresh({ expiresAt: ahead(7) }, ago(30), now)).toBe(false)
    expect(capSessionRefresh({ expiresAt: ahead(7) }, ago(45), now)).toBe(false)
  })

  it("ignores updates that do not touch expiresAt or lack createdAt", () => {
    expect(capSessionRefresh({ ipAddress: "1.2.3.4" }, ago(45), now)).toBe(
      undefined
    )
    expect(capSessionRefresh({ expiresAt: ahead(7) }, undefined, now)).toBe(
      undefined
    )
  })

  it("accepts ISO strings from secondary storage", () => {
    expect(
      capSessionRefresh(
        { expiresAt: ahead(7).toISOString() },
        ago(29).toISOString(),
        now
      )
    ).toEqual({ data: { expiresAt: ahead(1) } })
  })
})

describe("clampSessionSnapshot", () => {
  const snapshot = (createdAt: Date, expiresAt: Date) =>
    JSON.stringify({
      session: {
        token: "t",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
      user: { id: "u1" },
    })

  it("expires an over-age snapshot that still claims days of validity", () => {
    const createdAt = new Date(Date.now() - 31 * DAY)
    const out = JSON.parse(
      clampSessionSnapshot(snapshot(createdAt, new Date(Date.now() + 6 * DAY)))!
    )
    expect(new Date(out.session.expiresAt).getTime()).toBe(
      createdAt.getTime() + SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000
    )
    expect(new Date(out.session.expiresAt).getTime()).toBeLessThan(Date.now())
    expect(out.user).toEqual({ id: "u1" })
  })

  it("leaves snapshots within the cap byte-for-byte unchanged", () => {
    const raw = snapshot(
      new Date(Date.now() - DAY),
      new Date(Date.now() + 6 * DAY)
    )
    expect(clampSessionSnapshot(raw)).toBe(raw)
  })

  it("clamps regardless of the snapshot's key order", () => {
    const createdAt = new Date(Date.now() - 31 * DAY)
    const raw = JSON.stringify({
      user: { id: "u1" },
      session: {
        expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
        createdAt: createdAt.toISOString(),
      },
    })
    const out = JSON.parse(clampSessionSnapshot(raw)!)
    expect(new Date(out.session.expiresAt).getTime()).toBeLessThan(Date.now())
  })

  it("passes through non-session values", () => {
    expect(clampSessionSnapshot(null)).toBeNull()
    expect(clampSessionSnapshot("5")).toBe("5")
    expect(clampSessionSnapshot('{"session":broken')).toBe('{"session":broken')
    expect(clampSessionSnapshot('[{"token":"t","expiresAt":1}]')).toBe(
      '[{"token":"t","expiresAt":1}]'
    )
    const verification = JSON.stringify({ id: "v", expiresAt: "2020-01-01" })
    expect(clampSessionSnapshot(verification)).toBe(verification)
  })
})
