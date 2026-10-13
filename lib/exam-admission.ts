import { redis } from "./redis"
import { logError } from "./logger"

/**
 * Admission control for the exam-start burst: when a whole class joins in the
 * same second, each new joiner gets a place in line, because server rendering
 * does not degrade gracefully under a burst. One Redis counter per exam plus a short-lived
 * per-student hold; the client waits in a countdown card, not a held request.
 *
 * Only first joins queue. Resumes go straight through, and the wait happens
 * before the session row exists, so nobody loses exam time in line.
 */

/** Students admitted per second once a burst is under way. */
const DEFAULT_RATE_PER_SEC = 25

/** Nobody is ever held longer than this, however large the cohort. */
const DEFAULT_MAX_WAIT_SEC = 45

/**
 * How long joins count towards the same burst. Must stay well above
 * DEFAULT_MAX_WAIT_SEC so the counter never resets mid-cohort.
 */
const BURST_WINDOW_SEC = 120

/** Shorter waits are rounded down to 0 (not worth a round trip). */
const MIN_WAIT_MS = 1_000

function intFromEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

/** Admissions per second. Higher = shorter queue, bigger burst. */
export function admissionRatePerSec(): number {
  return intFromEnv(
    "EXAM_ADMISSION_RATE_PER_SEC",
    DEFAULT_RATE_PER_SEC,
    1,
    10_000
  )
}

/** Longest wait handed to any one student. 0 disables the queue entirely. */
export function admissionMaxWaitMs(): number {
  return (
    intFromEnv("EXAM_ADMISSION_MAX_WAIT_SEC", DEFAULT_MAX_WAIT_SEC, 0, 300) *
    1000
  )
}

/**
 * How long the caller must wait before it may be admitted, in milliseconds.
 *
 * The queue drains at a fixed `ratePerSec`, so the student holding rank `n`
 * is due `(n - 1) / rate` seconds after the burst opened. Subtracting the
 * time already elapsed makes the schedule absolute rather than relative,
 * which is what keeps an existing reservation from being punished for the
 * crowd that came after it. New reservations skip unused slots before they
 * get a rank, so idle time cannot accumulate capacity for another burst.
 *
 * `maxWaitMs` caps the wait from the moment the rank was handed out
 * (`assignedAtMs`, on the same burst clock as `elapsedMs`), not per request:
 * a student whose slot is further out than the cap is admitted once the cap
 * has passed since they first joined, rather than being handed the cap again
 * on every retry.
 *
 * Waits under MIN_WAIT_MS come back as 0: see there.
 *
 * Exported for tests — the surrounding Redis bookkeeping only supplies
 * `rank` and `elapsedMs`.
 */
export function admissionWaitMs({
  rank,
  elapsedMs,
  ratePerSec,
  maxWaitMs,
  assignedAtMs = elapsedMs,
}: {
  rank: number
  elapsedMs: number
  ratePerSec: number
  maxWaitMs: number
  assignedAtMs?: number
}): number {
  if (maxWaitMs <= 0) return 0
  const slotMs = ((Math.max(1, rank) - 1) / ratePerSec) * 1000
  const dueMs = Math.min(slotMs, Math.max(0, assignedAtMs) + maxWaitMs)
  const waitMs = dueMs - Math.max(0, elapsedMs)
  if (waitMs < MIN_WAIT_MS) return 0
  return Math.min(maxWaitMs, Math.round(waitMs))
}

// Assign (or re-read) this student's place in the exam's current burst.
//
// The hold key makes retries idempotent, so a student never moves back in
// line. The counter's TTL is the burst clock (`BURST_WINDOW_SEC - ttl`).
// The hold stores "rank:assignedAt:lifetime" so the max-wait cap is measured
// from the first join. A hold that outlives its counter is admitted at once;
// one that spans into a newer burst keeps its age from its own TTL.
const ASSIGN_RANK_SCRIPT = `
local window = tonumber(ARGV[1])
local holdWindow = tonumber(ARGV[2]) or window
local rate = tonumber(ARGV[3])
local hold = redis.call("GET", KEYS[2])
if hold then
  local held = redis.call("TTL", KEYS[1])
  if held < 0 then
    return { 1, window, 0 }
  end
  local sep = string.find(hold, ":", 1, true)
  if not sep then
    -- Hold written before assignedAt was recorded: cap from now.
    return { tonumber(hold), held, window - held }
  end
  local lifetimeSep = string.find(hold, ":", sep + 1, true)
  local assignedAt = tonumber(string.sub(hold, sep + 1, lifetimeSep and lifetimeSep - 1 or -1))
  local lifetime = lifetimeSep and tonumber(string.sub(hold, lifetimeSep + 1)) or window
  local remaining = redis.call("TTL", KEYS[2])
  -- Reconstruct this reservation's original burst clock from its own age.
  -- The counter can already belong to a newer burst while this hold lives.
  local elapsed = assignedAt + math.max(0, lifetime - remaining)
  return { tonumber(string.sub(hold, 1, sep - 1)), window - elapsed, assignedAt }
end
local rank = redis.call("INCR", KEYS[1])
if rank == 1 then
  redis.call("EXPIRE", KEYS[1], window)
end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  -- Only reachable against a counter left over without a TTL; INCR and
  -- EXPIRE above cannot be split, since this whole script is one atom.
  redis.call("EXPIRE", KEYS[1], window)
  ttl = window
end
local assignedAt = window - ttl
-- Skip unused slots after a quiet period so idle time cannot build up
-- capacity for a later burst. Existing holds keep their rank (above).
local currentSlot = math.floor(assignedAt * rate) + 1
if rank < currentSlot then
  rank = currentSlot
  redis.call("SET", KEYS[1], rank, "KEEPTTL")
end
redis.call("SET", KEYS[2], rank .. ":" .. assignedAt .. ":" .. holdWindow, "EX", holdWindow)
return { rank, ttl, assignedAt }
`

/**
 * Decide whether this student may start the exam now, or how long they wait.
 * Fails open (wait 0) when Redis is unreachable: this is only a load shaper.
 */
export async function reserveAdmission({
  examId,
  userId,
}: {
  examId: string
  userId: string
}): Promise<{ waitMs: number }> {
  const maxWaitMs = admissionMaxWaitMs()
  if (maxWaitMs <= 0) return { waitMs: 0 }
  const ratePerSec = admissionRatePerSec()

  try {
    const result = await redis.eval(
      ASSIGN_RANK_SCRIPT,
      2,
      `exam-admission:${examId}`,
      `exam-admission:${examId}:${userId}`,
      BURST_WINDOW_SEC,
      // Keep a reservation alive past its maximum wait, even when the
      // configured cap exceeds the counter's burst window.
      Math.max(BURST_WINDOW_SEC, Math.ceil(maxWaitMs / 1000) + 1),
      ratePerSec
    )
    const [rank, ttl, assignedAt] = (
      Array.isArray(result) ? result : [1, BURST_WINDOW_SEC, 0]
    ) as number[]
    const elapsedMs = (BURST_WINDOW_SEC - ttl) * 1000
    return {
      waitMs: admissionWaitMs({
        rank,
        elapsedMs,
        assignedAtMs:
          typeof assignedAt === "number" ? assignedAt * 1000 : elapsedMs,
        ratePerSec,
        maxWaitMs,
      }),
    }
  } catch (err) {
    logError("exam admission fail-open (Redis unreachable)", { examId, err })
    return { waitMs: 0 }
  }
}
