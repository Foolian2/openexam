/**
 * Date formatting for the UI and generated documents.
 *
 * Server-rendered dates used the server's time zone, which is UTC in the
 * Docker image. Client components marked `suppressHydrationWarning` kept that
 * server text after hydration, so a teacher in Zurich saw an exam scheduled
 * for 14:30 listed at 12:30 (CEST). OpenExam is run by Swiss schools, so
 * dates are always shown in Swiss time, whichever machine renders them.
 */
export const APP_TIME_ZONE = "Europe/Zurich"

type DateInput = Date | string | number

/** "7.10.2026, 14:30:00" */
export function formatDateTime(value: DateInput): string {
  return new Date(value).toLocaleString("de-CH", { timeZone: APP_TIME_ZONE })
}

/** "7.10.2026" */
export function formatDate(value: DateInput): string {
  return new Date(value).toLocaleDateString("de-CH", {
    timeZone: APP_TIME_ZONE,
  })
}

/** "14:30:00" */
export function formatTime(value: DateInput): string {
  return new Date(value).toLocaleTimeString("de-CH", {
    timeZone: APP_TIME_ZONE,
  })
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Minutes the Swiss wall clock is ahead of UTC at `date`. */
function swissOffsetMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date)
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value)
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  )
  return Math.round((wall - date.getTime()) / 60000)
}

/**
 * Start of a calendar day ("2026-10-07") in Swiss time, or null for anything
 * that is not a valid date-only string. DST switches happen at 02:00/03:00,
 * so the offset at UTC midnight is the offset at Swiss midnight.
 */
export function swissDayStart(day: string): Date | null {
  const m = DATE_ONLY.exec(day)
  if (!m) return null
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(utcMidnight)) return null
  const start = new Date(
    utcMidnight - swissOffsetMinutes(new Date(utcMidnight)) * 60000
  )
  return Number.isNaN(start.getTime()) ? null : start
}

/** A Swiss wall-clock time; month is 1-based. */
export interface SwissWallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** The Swiss calendar date and time of an instant. */
export function toSwissWallTime(date: Date): SwissWallTime {
  const shifted = new Date(date.getTime() + swissOffsetMinutes(date) * 60000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/**
 * The instant at which Swiss clocks show `wall`. The offset is resolved
 * twice so a time just after a DST switch lands on the right side of it.
 * The two DST edge cases: a time skipped in spring (02:30 on the last
 * Sunday of March) moves forward an hour, and the hour repeated in autumn
 * (02:00–03:00 on the last Sunday of October) resolves to its second,
 * standard-time occurrence.
 */
export function fromSwissWallTime(wall: SwissWallTime): Date {
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute
  )
  const first = asUtc - swissOffsetMinutes(new Date(asUtc)) * 60000
  return new Date(asUtc - swissOffsetMinutes(new Date(first)) * 60000)
}
