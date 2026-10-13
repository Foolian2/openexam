import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/grading/grade-session", () => ({
  autoGradeSession: vi.fn(),
}))

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
}))

const { gradeWithRetry } = await import("@/lib/grading/grade-with-retry")
const { autoGradeSession } = await import("@/lib/grading/grade-session")
const { logError } = await import("@/lib/logger")

const mocked = vi.mocked(autoGradeSession)
const mockedLogError = vi.mocked(logError)

beforeEach(() => {
  mocked.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("gradeWithRetry", () => {
  it("returns without retrying when grading succeeds on the first attempt", async () => {
    mocked.mockResolvedValue(undefined)
    await gradeWithRetry("session1")
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(mocked).toHaveBeenCalledWith("session1")
  })

  it("retries after a transient failure and succeeds", async () => {
    mocked.mockRejectedValueOnce(new Error("connection reset"))
    mocked.mockResolvedValue(undefined)

    const promise = gradeWithRetry("session1")
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(mocked).toHaveBeenCalledTimes(2)
  })

  it("gives up after three attempts without throwing", async () => {
    mocked.mockRejectedValue(new Error("db down"))
    mockedLogError.mockClear()

    const promise = gradeWithRetry("session1")
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(1_000)
    await promise

    expect(mocked).toHaveBeenCalledTimes(3)
    expect(mockedLogError).toHaveBeenCalledTimes(1)
    expect(mockedLogError.mock.calls[0][0]).toContain(
      "grading failed after retries"
    )
  })

  it("does not deduplicate two overlapping calls for the same session — idempotency is delegated entirely to autoGradeSession's own DB-conditioned writes, not to any lock here", async () => {
    // Realistic overlap: a client's retried submit request and the
    // post-commit auto-grade path both call gradeWithRetry(sessionId) at
    // roughly the same time. gradeWithRetry has no in-memory lock or
    // in-flight cache keyed on sessionId (see grade-with-retry.ts — it is a
    // plain per-call retry loop), so both calls independently invoke
    // autoGradeSession. That is safe ONLY because autoGradeSession itself is
    // idempotent at the DB layer (conditional UPDATE ... WHERE "autoGraded"
    // = true, and createMany({ skipDuplicates: true }) — see
    // grade-session.test.ts for those guarantees). This test locks in the
    // real, honest behavior at this layer: no dedup, no double-throw, no
    // spurious retries just from the overlap.
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<void>((r) => (resolveFirst = r))
    const second = new Promise<void>((r) => (resolveSecond = r))
    mocked.mockImplementationOnce(() => first)
    mocked.mockImplementationOnce(() => second)

    const p1 = gradeWithRetry("session1")
    const p2 = gradeWithRetry("session1")

    // Both overlapping calls already reached autoGradeSession independently
    // — nothing coalesced them into a single underlying grade attempt.
    expect(mocked).toHaveBeenCalledTimes(2)
    expect(mocked).toHaveBeenNthCalledWith(1, "session1")
    expect(mocked).toHaveBeenNthCalledWith(2, "session1")

    resolveFirst()
    resolveSecond()
    await Promise.all([p1, p2])

    // Both resolved cleanly (no retry loop triggered by the overlap itself),
    // and still exactly one autoGradeSession call per gradeWithRetry call —
    // i.e. the overlap did not cause any extra grading attempts on its own.
    expect(mocked).toHaveBeenCalledTimes(2)
  })
})
