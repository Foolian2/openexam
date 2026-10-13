import { describe, expect, it } from "vitest"
import {
  formatDate,
  formatDateTime,
  formatTime,
  fromSwissWallTime,
  toSwissWallTime,
} from "@/lib/format-date"

// The test runner's own time zone must not matter: these are the strings a
// UTC server and a browser in Zurich both have to render.
describe("format-date", () => {
  it("shows summer times in CEST (UTC+2)", () => {
    expect(formatDateTime("2026-10-07T12:30:00Z")).toBe("7.10.2026, 14:30:00")
    expect(formatTime("2026-10-07T12:30:00Z")).toBe("14:30:00")
  })

  it("shows winter times in CET (UTC+1)", () => {
    expect(formatDateTime("2026-01-15T12:30:00Z")).toBe("15.1.2026, 13:30:00")
  })

  it("rolls the date over at Swiss midnight, not UTC midnight", () => {
    expect(formatDate("2026-10-07T22:30:00Z")).toBe("8.10.2026")
    expect(formatDate(new Date("2026-10-07T21:59:00Z"))).toBe("7.10.2026")
  })
})

describe("Swiss wall time", () => {
  it("reads an instant as Swiss wall-clock time", () => {
    expect(toSwissWallTime(new Date("2026-10-07T12:30:00Z"))).toEqual({
      year: 2026,
      month: 10,
      day: 7,
      hour: 14,
      minute: 30,
    })
    // 23:30 UTC on the 7th is already the 8th in Zurich
    expect(toSwissWallTime(new Date("2026-01-07T23:30:00Z"))).toMatchObject({
      day: 8,
      hour: 0,
      minute: 30,
    })
  })

  it("turns Swiss wall-clock time into the instant, summer and winter", () => {
    const wall = { year: 2026, month: 10, day: 7, hour: 14, minute: 30 }
    expect(fromSwissWallTime(wall).toISOString()).toBe(
      "2026-10-07T12:30:00.000Z"
    )
    expect(
      fromSwissWallTime({ ...wall, month: 1, day: 15 }).toISOString()
    ).toBe("2026-01-15T13:30:00.000Z")
  })

  it("round-trips across the DST switches", () => {
    // 29 Mar 2026: 02:00 → 03:00; 25 Oct 2026: 03:00 → 02:00
    for (const iso of [
      "2026-03-29T00:59:00Z", // 01:59 CET
      "2026-03-29T01:00:00Z", // 03:00 CEST
      "2026-10-24T23:59:00Z", // 01:59 CEST, just before the repeated hour
      "2026-10-25T02:00:00Z", // 03:00 CET
    ]) {
      const instant = new Date(iso)
      expect(fromSwissWallTime(toSwissWallTime(instant)).toISOString()).toBe(
        instant.toISOString()
      )
    }
  })

  it("picks the standard-time occurrence of the repeated autumn hour", () => {
    const repeated = { year: 2026, month: 10, day: 25, hour: 2, minute: 30 }
    expect(fromSwissWallTime(repeated).toISOString()).toBe(
      "2026-10-25T01:30:00.000Z"
    )
  })

  it("moves a time skipped in spring forward an hour", () => {
    const skipped = { year: 2026, month: 3, day: 29, hour: 2, minute: 30 }
    expect(toSwissWallTime(fromSwissWallTime(skipped))).toMatchObject({
      hour: 3,
      minute: 30,
    })
  })
})
