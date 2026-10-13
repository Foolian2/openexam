import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  lease: vi.fn(),
  release: vi.fn(),
  find: vi.fn(),
  claim: vi.fn(),
  finalize: vi.fn(),
  log: vi.fn(),
}))
vi.mock("@/lib/redis", () => ({
  redis: { set: mocks.lease, eval: mocks.release },
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { examSession: { findMany: mocks.find, updateMany: mocks.claim } },
}))
vi.mock("@/lib/finalize-session", () => ({ finalizeSession: mocks.finalize }))
vi.mock("@/lib/logger", () => ({ logError: mocks.log }))
import {
  sweepExpiredSessions,
  DEADLINE_RECOVERY_GRACE_MS,
} from "@/lib/deadline-sweeper"
const now = new Date("2026-10-06T10:00:00Z")
const candidate = {
  id: "s1",
  examId: "e1",
  userId: "u1",
  deadlineFinalizationPending: false,
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.lease.mockResolvedValue("OK")
  mocks.find.mockResolvedValue([candidate])
  mocks.claim.mockResolvedValue({ count: 1 })
  mocks.release.mockResolvedValue(1)
  mocks.finalize.mockResolvedValue(undefined)
})
describe("deadline sweeper", () => {
  it("does nothing when another replica owns the lease", async () => {
    mocks.lease.mockResolvedValue(null)
    expect(await sweepExpiredSessions(now)).toBe(0)
    expect(mocks.find).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })
  it("claims expired IN_PROGRESS and LOCKED sessions with the same live deadline predicate", async () => {
    expect(await sweepExpiredSessions(now)).toBe(1)
    const cutoff = new Date(now.getTime() - DEADLINE_RECOVERY_GRACE_MS)
    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            {
              status: { in: ["IN_PROGRESS", "LOCKED"] },
              effectiveEndTime: { lte: cutoff },
            },
            {
              deadlineFinalizationPending: true,
              status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
              submittedAt: { lte: cutoff },
            },
          ],
        },
        take: 25,
      })
    )
    expect(mocks.claim).toHaveBeenCalledWith({
      where: {
        id: "s1",
        status: { in: ["IN_PROGRESS", "LOCKED"] },
        effectiveEndTime: { lte: cutoff },
      },
      data: {
        status: "AUTO_SUBMITTED",
        submissionType: "AUTO_TIME",
        submittedAt: now,
        needsRegrade: true,
        deadlineFinalizationPending: true,
      },
    })
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: ["s1"],
        audit: expect.objectContaining({
          examId: "e1",
          metadata: { submissionType: "AUTO_TIME", source: "deadline-sweeper" },
        }),
      })
    )
  })
  it("does not finalize when a concurrent extension or submission defeats the claim", async () => {
    mocks.claim.mockResolvedValue({ count: 0 })
    expect(await sweepExpiredSessions(now)).toBe(0)
    expect(mocks.finalize).not.toHaveBeenCalled()
  })
  it("continues finalizing others after a post-commit failure", async () => {
    mocks.find.mockResolvedValue([candidate, { ...candidate, id: "s2" }])
    mocks.finalize.mockRejectedValueOnce(new Error("transient failure"))
    expect(await sweepExpiredSessions(now)).toBe(2)
    expect(mocks.finalize).toHaveBeenCalledTimes(2)
    expect(mocks.log).toHaveBeenCalledOnce()
    expect(
      mocks.release.mock.calls.filter(
        ([script, , key]: unknown[]) =>
          key === "deadline-sweeper:lock" &&
          String(script).includes('redis.call("DEL", KEYS[1])')
      )
    ).toHaveLength(1)
    expect(
      mocks.release.mock.calls.filter(
        ([script, , key]: unknown[]) =>
          String(key).startsWith("deadline-sweeper:session:") &&
          String(script).includes('redis.call("DEL", KEYS[1])')
      )
    ).toHaveLength(2)
  })
  it("retries a terminal pending session without resubmitting or changing its timestamp", async () => {
    mocks.find.mockResolvedValue([
      { ...candidate, deadlineFinalizationPending: true },
    ])
    expect(await sweepExpiredSessions(now)).toBe(0)
    expect(mocks.lease).toHaveBeenCalledWith(
      "deadline-sweeper:session:s1",
      expect.any(String),
      "EX",
      60,
      "NX"
    )
    expect(mocks.finalize).toHaveBeenCalledOnce()
    expect(mocks.claim).toHaveBeenCalledExactlyOnceWith({
      where: { id: "s1", deadlineFinalizationPending: true },
      data: { deadlineFinalizationPending: false },
    })
  })

  it("recovers a close-forced session with the submission type its claimer recorded", async () => {
    mocks.find.mockResolvedValue([
      {
        ...candidate,
        submissionType: "TEACHER_FORCED",
        deadlineFinalizationPending: true,
      },
    ])
    await sweepExpiredSessions(now)
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIds: ["s1"],
        audit: expect.objectContaining({
          metadata: {
            submissionType: "TEACHER_FORCED",
            source: "finalization-recovery",
          },
        }),
      })
    )
  })

  it("releases only its own lease even after database failure", async () => {
    mocks.find.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(sweepExpiredSessions(now)).rejects.toThrow(
      "database unavailable"
    )
    const token = mocks.lease.mock.calls[0][1]
    expect(mocks.release).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("GET", KEYS[1]) == ARGV[1]'),
      1,
      "deadline-sweeper:lock",
      token
    )
  })

  it("renews both leases and stops claiming candidates when global ownership is lost", async () => {
    vi.useFakeTimers()
    try {
      mocks.find.mockResolvedValue([candidate, { ...candidate, id: "s2" }])
      let finishFirst!: () => void
      let enteredFirst!: () => void
      const firstEntered = new Promise<void>((resolve) => {
        enteredFirst = resolve
      })
      const firstFinalize = new Promise<void>((resolve) => {
        finishFirst = resolve
      })
      mocks.finalize
        .mockImplementationOnce(async () => {
          enteredFirst()
          await firstFinalize
        })
        .mockResolvedValueOnce(undefined)

      const sweep = sweepExpiredSessions(now)
      await firstEntered
      const token = mocks.lease.mock.calls[0][1]
      mocks.release.mockImplementation(
        async (script: string, _n: number, key: string) => {
          if (script.includes("PEXPIRE") && key === "deadline-sweeper:lock")
            return 0
          return 1
        }
      )

      await vi.advanceTimersByTimeAsync(20_000)
      expect(mocks.release).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("PEXPIRE", KEYS[1], ARGV[2])'),
        1,
        "deadline-sweeper:lock",
        token,
        60_000
      )
      expect(mocks.release).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("PEXPIRE", KEYS[1], ARGV[2])'),
        1,
        "deadline-sweeper:session:s1",
        expect.any(String),
        60_000
      )

      finishFirst()
      expect(await sweep).toBe(1)
      expect(mocks.finalize).toHaveBeenCalledOnce()
      expect(
        mocks.claim.mock.calls.some(
          ([arg]: unknown[]) =>
            (arg as { where?: { id?: string } })?.where?.id === "s2"
        )
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps another sweep from retrying a session with an active session lease", async () => {
    const sessionOwners = new Map<string, string>()
    mocks.find.mockResolvedValue([
      { ...candidate, deadlineFinalizationPending: true },
    ])
    mocks.lease.mockImplementation(async (key: string, token: string) => {
      if (key === "deadline-sweeper:lock") return "OK"
      if (sessionOwners.has(key)) return null
      sessionOwners.set(key, token)
      return "OK"
    })

    let finishFirst!: () => void
    let enteredFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    const firstFinalize = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    mocks.finalize.mockImplementationOnce(async () => {
      enteredFirst()
      await firstFinalize
    })

    const firstSweep = sweepExpiredSessions(now)
    await firstEntered
    expect(await sweepExpiredSessions(now)).toBe(0)
    expect(mocks.finalize).toHaveBeenCalledOnce()

    finishFirst()
    await firstSweep
    expect(mocks.finalize).toHaveBeenCalledOnce()
  })
})
