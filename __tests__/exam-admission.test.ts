import Redis from "ioredis"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const redisMock = vi.hoisted(() => ({
  eval: vi.fn<
    (
      script: string,
      numKeys: number,
      burstKey: string,
      holdKey: string,
      windowSec: number,
      holdSec: number,
      ratePerSec: number
    ) => Promise<unknown>
  >(),
}))

vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }))

import {
  admissionMaxWaitMs,
  admissionRatePerSec,
  admissionWaitMs,
  reserveAdmission,
} from "@/lib/exam-admission"

// Mirrors BURST_WINDOW_SEC in the module: the burst counter's remaining TTL
// is how the module reads elapsed time, so a test that wants "the burst
// opened n seconds ago" returns a TTL of WINDOW - n.
const WINDOW = 120
const ttlAfter = (elapsedSec: number) => WINDOW - elapsedSec

const envKeys = [
  "EXAM_ADMISSION_RATE_PER_SEC",
  "EXAM_ADMISSION_MAX_WAIT_SEC",
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  vi.clearAllMocks()
  for (const key of envKeys) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe("admissionWaitMs", () => {
  const base = { elapsedMs: 0, ratePerSec: 25, maxWaitMs: 45_000 }

  it("lets the front of the queue straight in", () => {
    expect(admissionWaitMs({ ...base, rank: 1 })).toBe(0)
  })

  it("spaces later ranks out at the configured rate", () => {
    // At 25/s the 26th joiner is due one second after the burst opened.
    expect(admissionWaitMs({ ...base, rank: 26 })).toBe(1_000)
    expect(admissionWaitMs({ ...base, rank: 251 })).toBe(10_000)
  })

  it("lets the first second's worth of a cohort straight through", () => {
    // Ranks 2..25 are due within a second, which is not worth a round trip
    // and a flash of the waiting room — so a class of 25 never sees the
    // queue. Rank 26 is the first one actually held.
    for (let rank = 1; rank <= 25; rank++) {
      expect(admissionWaitMs({ ...base, rank })).toBe(0)
    }
    expect(admissionWaitMs({ ...base, rank: 26 })).toBeGreaterThan(0)
  })

  it("applies the same floor after crediting elapsed time", () => {
    // Due at +10 s, arriving 9.5 s in: the remaining half-second is below the
    // floor, so they walk in rather than being bounced for 500 ms.
    expect(admissionWaitMs({ ...base, rank: 251, elapsedMs: 9_500 })).toBe(0)
  })

  it("credits time already spent in the burst", () => {
    expect(admissionWaitMs({ ...base, rank: 251, elapsedMs: 4_000 })).toBe(
      6_000
    )
  })

  it("admits a straggler the burst has already moved past", () => {
    // Rank 251 is due at +10 s; arriving 30 s in, they are overdue, so the
    // queue must not charge them for the crowd that came before them.
    expect(admissionWaitMs({ ...base, rank: 251, elapsedMs: 30_000 })).toBe(0)
  })

  it("never holds anyone past the cap, however large the cohort", () => {
    expect(admissionWaitMs({ ...base, rank: 100_000 })).toBe(45_000)
  })

  it("measures the cap from the first join, not from each retry", () => {
    // Rank 2501 is due at +100 s. Joined at 0 s, capped at 45 s: the retry
    // at 45 s must be admitted, not handed another 45 s (then 10 s).
    expect(
      admissionWaitMs({ ...base, rank: 2501, elapsedMs: 0, assignedAtMs: 0 })
    ).toBe(45_000)
    expect(
      admissionWaitMs({
        ...base,
        rank: 2501,
        elapsedMs: 45_000,
        assignedAtMs: 0,
      })
    ).toBe(0)
    // A retry that comes back early only waits out the rest of the cap.
    expect(
      admissionWaitMs({
        ...base,
        rank: 2501,
        elapsedMs: 30_000,
        assignedAtMs: 0,
      })
    ).toBe(15_000)
    // Joined late in the burst: the cap runs from that moment.
    expect(
      admissionWaitMs({
        ...base,
        rank: 2501,
        elapsedMs: 20_000,
        assignedAtMs: 20_000,
      })
    ).toBe(45_000)
  })

  it("treats a zero cap as the queue being switched off", () => {
    expect(admissionWaitMs({ ...base, rank: 100_000, maxWaitMs: 0 })).toBe(0)
  })
})

describe("admission configuration", () => {
  it("defaults to 25 admissions per second and a 45 s cap", () => {
    expect(admissionRatePerSec()).toBe(25)
    expect(admissionMaxWaitMs()).toBe(45_000)
  })

  it("reads overrides from the environment", () => {
    process.env.EXAM_ADMISSION_RATE_PER_SEC = "60"
    process.env.EXAM_ADMISSION_MAX_WAIT_SEC = "20"
    expect(admissionRatePerSec()).toBe(60)
    expect(admissionMaxWaitMs()).toBe(20_000)
  })

  it("clamps out-of-range values instead of producing a nonsense schedule", () => {
    // A rate of 0 would divide the whole cohort by zero; a negative cap would
    // make every wait negative and silently disable the queue.
    process.env.EXAM_ADMISSION_RATE_PER_SEC = "0"
    process.env.EXAM_ADMISSION_MAX_WAIT_SEC = "-5"
    expect(admissionRatePerSec()).toBe(1)
    expect(admissionMaxWaitMs()).toBe(0)
  })

  it("falls back to the defaults for unparseable values", () => {
    process.env.EXAM_ADMISSION_RATE_PER_SEC = "fast"
    process.env.EXAM_ADMISSION_MAX_WAIT_SEC = ""
    expect(admissionRatePerSec()).toBe(25)
    expect(admissionMaxWaitMs()).toBe(45_000)
  })
})

describe("reserveAdmission", () => {
  it("admits the first joiner of a burst immediately", async () => {
    redisMock.eval.mockResolvedValue([1, ttlAfter(0)])
    await expect(
      reserveAdmission({ examId: "e1", userId: "u1" })
    ).resolves.toEqual({ waitMs: 0 })
  })

  it("holds a joiner whose turn has not come round yet", async () => {
    redisMock.eval.mockResolvedValue([501, ttlAfter(0)])
    const { waitMs } = await reserveAdmission({ examId: "e1", userId: "u1" })
    expect(waitMs).toBe(20_000)
  })

  it("admits a retry once the cap has passed since the first join", async () => {
    // Rank 2501, assigned at 0 s, retrying 45 s into the burst.
    redisMock.eval.mockResolvedValue([2501, ttlAfter(45), 0])
    await expect(
      reserveAdmission({ examId: "e1", userId: "u1" })
    ).resolves.toEqual({ waitMs: 0 })
  })

  it("keys the counter per exam and the hold per student", async () => {
    redisMock.eval.mockResolvedValue([1, ttlAfter(0)])
    await reserveAdmission({ examId: "e1", userId: "u1" })
    const [, numKeys, burstKey, holdKey] = redisMock.eval.mock.calls[0]
    expect(numKeys).toBe(2)
    expect(burstKey).toBe("exam-admission:e1")
    expect(holdKey).toBe("exam-admission:e1:u1")
  })

  it("fails open when Redis is unreachable", async () => {
    // Deliberately the opposite of the join route's rate limiter: this is a
    // load shaper, and refusing to let a class sit their exam because Redis
    // blipped is far worse than the burst it smooths.
    redisMock.eval.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(
      reserveAdmission({ examId: "e1", userId: "u1" })
    ).resolves.toEqual({ waitMs: 0 })
  })

  it("does not touch Redis at all when the queue is switched off", async () => {
    process.env.EXAM_ADMISSION_MAX_WAIT_SEC = "0"
    await expect(
      reserveAdmission({ examId: "e1", userId: "u1" })
    ).resolves.toEqual({ waitMs: 0 })
    expect(redisMock.eval).not.toHaveBeenCalled()
  })
})

// Exercise the Lua bookkeeping itself when an isolated Redis is available.
// The normal unit suite remains independent of an external service.
describe.skipIf(!process.env.REDIS_TEST_URL)(
  "Redis admission scheduling",
  () => {
    async function fixture() {
      const client = new Redis(process.env.REDIS_TEST_URL!)
      const examId = `review-${Math.random().toString(36).slice(2)}`
      const burstKey = `exam-admission:${examId}`
      const holdKey = `${burstKey}:student`
      redisMock.eval.mockImplementation(
        (script, numKeys, burst, hold, window, lifetime, rate) =>
          client.eval(script, numKeys, burst, hold, window, lifetime, rate)
      )
      return { client, examId, burstKey, holdKey }
    }

    it("stages a simultaneous cohort after one early join and an idle period", async () => {
      const { client, examId, burstKey } = await fixture()
      const students = Array.from({ length: 500 }, (_, i) => `student-${i}`)
      try {
        expect(await reserveAdmission({ examId, userId: "early" })).toEqual({
          waitMs: 0,
        })
        // Model 30 seconds of idle time without waiting in the test.
        await client.expire(burstKey, WINDOW - 30)
        const waits = await Promise.all(
          students.map((userId) => reserveAdmission({ examId, userId }))
        )
        expect(waits.filter(({ waitMs }) => waitMs === 0)).toHaveLength(25)
        expect(waits[25].waitMs).toBe(1_000)
        expect(waits[499].waitMs).toBe(19_960)
        // Advancing the counter retains its original burst clock.
        expect(await client.ttl(burstKey)).toBe(WINDOW - 30)
        // Retrying a queued reservation does not consume another slot.
        const rank = await client.get(burstKey)
        expect(
          await reserveAdmission({ examId, userId: students[25] })
        ).toEqual(waits[25])
        expect(await client.get(burstKey)).toBe(rank)
        // Once time passes, the original reservation is honoured, even when
        // another new arrival advances the counter again after a quiet spell.
        await client.expire(burstKey, WINDOW - 60)
        const queuedKey = `${burstKey}:${students[25]}`
        await client.expire(queuedKey, WINDOW - 30)
        await reserveAdmission({ examId, userId: "late" })
        expect(
          await reserveAdmission({ examId, userId: students[25] })
        ).toEqual({
          waitMs: 0,
        })
      } finally {
        await client.del(
          burstKey,
          `${burstKey}:early`,
          `${burstKey}:late`,
          ...students.map((userId) => `${burstKey}:${userId}`)
        )
        await client.quit()
      }
    })

    it("credits a legacy hold's age when another student opened a fresh burst", async () => {
      const { client, examId, burstKey, holdKey } = await fixture()
      try {
        process.env.EXAM_ADMISSION_RATE_PER_SEC = "1"
        // Assigned at old-burst +100s, retried 21s later; a new burst is at 0s.
        await client.set(burstKey, "1", "EX", WINDOW)
        await client.set(holdKey, "200:100", "EX", WINDOW - 21)
        const { waitMs } = await reserveAdmission({ examId, userId: "student" })
        expect(waitMs).toBeGreaterThanOrEqual(23_000)
        expect(waitMs).toBeLessThanOrEqual(24_000)
      } finally {
        await client.del(burstKey, holdKey)
        await client.quit()
      }
    })

    it("keeps a long-cap reservation through counter rollover and honours its original deadline", async () => {
      const { client, examId, burstKey, holdKey } = await fixture()
      try {
        process.env.EXAM_ADMISSION_RATE_PER_SEC = "1"
        process.env.EXAM_ADMISSION_MAX_WAIT_SEC = "300"
        await client.set(burstKey, "1000", "EX", WINDOW)
        expect(
          (await reserveAdmission({ examId, userId: "student" })).waitMs
        ).toBe(300_000)
        expect(await client.ttl(holdKey)).toBeGreaterThanOrEqual(300)
        // Model 150 seconds elapsed while a new burst opened at 0s.
        await client.expire(holdKey, 151)
        const retry = await reserveAdmission({ examId, userId: "student" })
        expect(retry.waitMs).toBeGreaterThanOrEqual(149_000)
        expect(retry.waitMs).toBeLessThanOrEqual(150_000)
        await client.expire(holdKey, 1)
        expect(await reserveAdmission({ examId, userId: "student" })).toEqual({
          waitMs: 0,
        })
      } finally {
        await client.del(burstKey, holdKey)
        await client.quit()
      }
    })
  }
)
