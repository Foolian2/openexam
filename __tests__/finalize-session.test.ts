import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const callLog: string[] = []

vi.mock("@/lib/grading/grade-with-retry", () => ({
  gradeWithRetry: vi.fn(async (sessionId: string) => {
    callLog.push(`grade:${sessionId}`)
  }),
}))

vi.mock("@/lib/redis", () => ({
  redis: {
    publish: vi.fn(async () => {
      callLog.push("publish")
    }),
    // Implemented (not left undefined) so the try/catch around it in
    // finalizeSession doesn't silently swallow a TypeError on every call —
    // that used to mask waitForAnswerBufferDrain never actually running.
    set: vi.fn(async () => "OK"),
    exists: vi.fn(async () => 0),
    // Default: buffer already empty, so waitForAnswerBufferDrain resolves on
    // the first check without any extra polling delay. Tests that care about
    // the polling behavior itself override this.
    hkeys: vi.fn(async () => []),
  },
}))

vi.mock("@/lib/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { examSession: { findMany: vi.fn(async () => []) } },
}))

vi.mock("@/lib/audit", () => ({
  createAuditLog: vi.fn(async () => {
    callLog.push("audit")
  }),
}))

const { finalizeSession, gradeSessions, regradeFlaggedSessions } =
  await import("@/lib/finalize-session")
const { prisma } = await import("@/lib/prisma")
const { gradeWithRetry } = await import("@/lib/grading/grade-with-retry")
const { redis } = await import("@/lib/redis")
const { createAuditLog } = await import("@/lib/audit")
const { logError } = await import("@/lib/logger")

const gradeMock = vi.mocked(gradeWithRetry)
const logErrorMock = vi.mocked(logError)
const publishMock = vi.mocked(redis.publish)
const auditMock = vi.mocked(createAuditLog)
const setMock = vi.mocked(redis.set)
const hkeysMock = vi.mocked(redis.hkeys)
const existsMock = vi.mocked(redis.exists)

beforeEach(() => {
  callLog.length = 0
  gradeMock.mockReset()
  publishMock.mockReset()
  auditMock.mockReset()
  setMock.mockReset()
  setMock.mockImplementation(async () => "OK")
  hkeysMock.mockReset()
  hkeysMock.mockImplementation(async () => [])
  existsMock.mockReset()
  existsMock.mockImplementation(async () => 0)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("finalizeSession", () => {
  const dedupeInput = {
    examId: "X",
    sessionIds: ["s1"],
    control: { type: "SESSION_SUBMITTED", sessionId: "s1" },
    dedupeKey: "SESSION_SUBMITTED:s1",
    audit: {
      action: "SESSION_SUBMITTED",
      entityType: "ExamSession",
      entityId: "s1",
      userId: "u1",
    },
  }

  it("passes the dedupe key to the audit write and marks the publish", async () => {
    await finalizeSession(dedupeInput)
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "SESSION_SUBMITTED:s1" })
    )
    expect(publishMock).toHaveBeenCalledOnce()
    expect(setMock).toHaveBeenCalledWith(
      "finalize:published:SESSION_SUBMITTED:s1",
      "1",
      "EX",
      86_400,
      "NX"
    )
  })

  it("skips a control message an earlier run already published, but still grades and audits", async () => {
    existsMock.mockImplementation(async () => 1)
    await finalizeSession(dedupeInput)
    expect(publishMock).not.toHaveBeenCalled()
    expect(gradeMock).toHaveBeenCalledWith("s1")
    expect(auditMock).toHaveBeenCalledOnce()
  })

  it("does not mark the publish when publishing failed, so a retry still delivers it", async () => {
    publishMock.mockRejectedValueOnce(new Error("redis down"))
    await finalizeSession(dedupeInput)
    expect(setMock).not.toHaveBeenCalledWith(
      "finalize:published:SESSION_SUBMITTED:s1",
      "1",
      "EX",
      86_400,
      "NX"
    )
  })

  it("publishes without a marker when no dedupe key is given", async () => {
    await finalizeSession({ ...dedupeInput, dedupeKey: undefined })
    expect(existsMock).not.toHaveBeenCalled()
    expect(publishMock).toHaveBeenCalledOnce()
  })

  it("publishes, grades, then audits in order for a single session", async () => {
    await finalizeSession({
      examId: "X",
      sessionIds: ["s1"],
      control: { type: "SESSION_SUBMITTED", sessionId: "s1" },
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: "s1",
        userId: "u1",
        ipAddress: "1.2.3.4",
      },
    })

    expect(gradeMock).toHaveBeenCalledTimes(1)
    expect(gradeMock).toHaveBeenCalledWith("s1")
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledWith({
      action: "SESSION_SUBMITTED",
      entityType: "ExamSession",
      entityId: "s1",
      examId: undefined,
      userId: "u1",
      metadata: undefined,
      ipAddress: "1.2.3.4",
    })
    expect(callLog).toEqual(["publish", "grade:s1", "audit"])
  })

  it("grades in batches of five and publishes/audits once for many sessions", async () => {
    const sessionIds = Array.from({ length: 9 }, (_, i) => `s${i + 1}`)

    await finalizeSession({
      examId: "X",
      sessionIds,
      control: { type: "EXAM_CLOSED" },
      audit: {
        action: "EXAM_CLOSED",
        entityType: "Exam",
        entityId: "X",
        examId: "X",
        userId: "u1",
        metadata: { forcedSubmissions: 9 },
      },
    })

    expect(gradeMock).toHaveBeenCalledTimes(9)
    expect(gradeMock.mock.calls.map(([id]) => id)).toEqual(sessionIds)
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledTimes(1)
    expect(callLog).toEqual([
      "publish",
      ...sessionIds.map((id) => `grade:${id}`),
      "audit",
    ])
  })

  it("publishes the exact control payload the hub parses", async () => {
    await finalizeSession({
      examId: "X",
      sessionIds: ["s1"],
      control: { type: "SESSION_SUBMITTED", sessionId: "s1" },
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: "s1",
        userId: "u1",
      },
    })

    expect(publishMock).toHaveBeenCalledWith(
      "exam:X:control",
      '{"type":"SESSION_SUBMITTED","sessionId":"s1"}'
    )
  })

  it("swallows a publish failure and still writes the audit log", async () => {
    publishMock.mockRejectedValueOnce(new Error("redis down"))

    await expect(
      finalizeSession({
        examId: "X",
        sessionIds: ["s1"],
        control: { type: "SESSION_SUBMITTED", sessionId: "s1" },
        audit: {
          action: "SESSION_SUBMITTED",
          entityType: "ExamSession",
          entityId: "s1",
          userId: "u1",
        },
      })
    ).resolves.toBeUndefined()

    expect(gradeMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledTimes(1)
    expect(callLog).toEqual(["grade:s1", "audit"])
  })

  it("swallows a grading rejection and still publishes and audits", async () => {
    gradeMock.mockRejectedValueOnce(new Error("db down"))
    logErrorMock.mockClear()

    await expect(
      finalizeSession({
        examId: "X",
        sessionIds: ["s1"],
        control: { type: "SESSION_SUBMITTED", sessionId: "s1" },
        audit: {
          action: "SESSION_SUBMITTED",
          entityType: "ExamSession",
          entityId: "s1",
          userId: "u1",
        },
      })
    ).resolves.toBeUndefined()

    expect(logErrorMock).toHaveBeenCalledTimes(1)
    expect(publishMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledTimes(1)
    expect(callLog).toEqual(["publish", "audit"])
  })

  it("honors a custom grading batch size", async () => {
    const sessionIds = ["a", "b", "c"]
    gradeMock.mockImplementationOnce(async () => {
      callLog.push("first-batch")
    })

    await finalizeSession({
      examId: "X",
      sessionIds,
      control: { type: "EXAM_CLOSED" },
      audit: {
        action: "EXAM_CLOSED",
        entityType: "Exam",
        entityId: "X",
        userId: "u1",
      },
      gradingBatchSize: 3,
    })

    expect(gradeMock).toHaveBeenCalledTimes(3)
    expect(callLog).toContain("first-batch")
  })
})

describe("waitForAnswerBufferDrain (exercised via finalizeSession)", () => {
  it("arms the WS submitted gate in Redis for every finalizing session", async () => {
    await finalizeSession({
      examId: "X",
      sessionIds: ["s1", "s2"],
      control: { type: "SESSION_SUBMITTED" },
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: "s1",
        userId: "u1",
      },
    })

    expect(setMock).toHaveBeenCalledTimes(2)
    expect(setMock).toHaveBeenCalledWith("ws:submitted:s1", "1", "EX", 3600)
    expect(setMock).toHaveBeenCalledWith("ws:submitted:s2", "1", "EX", 3600)
  })

  it("polls exam:{examId}:answers and does NOT grade until the buffer for the finalizing sessions has drained", async () => {
    vi.useFakeTimers()
    hkeysMock
      .mockResolvedValueOnce(["s1:q1", "s2:q1"]) // both still buffered
      .mockResolvedValueOnce(["s1:q1"]) // s2 flushed, s1 still buffered
      .mockResolvedValueOnce([]) // fully drained

    const promise = finalizeSession({
      examId: "X",
      sessionIds: ["s1", "s2"],
      control: { type: "SESSION_SUBMITTED" },
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: "s1",
        userId: "u1",
      },
    })

    // First check (immediate, no timer yet): still pending, grading blocked.
    await vi.advanceTimersByTimeAsync(0)
    expect(hkeysMock).toHaveBeenCalledTimes(1)
    expect(gradeMock).not.toHaveBeenCalled()

    // Second check after the 200ms poll backoff: still pending.
    await vi.advanceTimersByTimeAsync(200)
    expect(hkeysMock).toHaveBeenCalledTimes(2)
    expect(gradeMock).not.toHaveBeenCalled()

    // Third check drains the buffer -> grading is now allowed to proceed.
    await vi.advanceTimersByTimeAsync(200)
    await promise

    expect(hkeysMock).toHaveBeenCalledTimes(3)
    expect(hkeysMock).toHaveBeenCalledWith("exam:X:answers")
    expect(gradeMock).toHaveBeenCalledTimes(2)
    // Grading only happened after the buffer drained.
    expect(callLog.filter((e) => e.startsWith("grade:"))).toHaveLength(2)
  })

  it("ignores hkeys entries for other sessions and proceeds without waiting", async () => {
    hkeysMock.mockResolvedValueOnce(["other-session:q1"])

    await finalizeSession({
      examId: "X",
      sessionIds: ["s1"],
      control: { type: "SESSION_SUBMITTED" },
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: "s1",
        userId: "u1",
      },
    })

    expect(hkeysMock).toHaveBeenCalledTimes(1)
    expect(gradeMock).toHaveBeenCalledTimes(1)
  })

  it("gives up after the bounded timeout and grades anyway if the buffer never drains", async () => {
    vi.useFakeTimers()
    hkeysMock.mockResolvedValue(["s1:q1"]) // never drains

    const promise = finalizeSession({
      examId: "X",
      sessionIds: ["s1"],
      control: { type: "SESSION_SUBMITTED" },
      audit: {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: "s1",
        userId: "u1",
      },
    })

    await vi.advanceTimersByTimeAsync(8000)
    await promise

    expect(gradeMock).toHaveBeenCalledTimes(1)
  })

  it("stops polling and grades anyway if hkeys itself fails", async () => {
    hkeysMock.mockRejectedValueOnce(new Error("redis down"))

    await expect(
      finalizeSession({
        examId: "X",
        sessionIds: ["s1"],
        control: { type: "SESSION_SUBMITTED" },
        audit: {
          action: "SESSION_SUBMITTED",
          entityType: "ExamSession",
          entityId: "s1",
          userId: "u1",
        },
      })
    ).resolves.toBeUndefined()

    expect(hkeysMock).toHaveBeenCalledTimes(1)
    expect(gradeMock).toHaveBeenCalledTimes(1)
  })
})

describe("gradeSessions", () => {
  it("grades each session in order without publishing or auditing", async () => {
    const sessionIds = Array.from({ length: 7 }, (_, i) => `s${i + 1}`)

    await gradeSessions(sessionIds)

    expect(gradeMock).toHaveBeenCalledTimes(7)
    expect(gradeMock.mock.calls.map(([id]) => id)).toEqual(sessionIds)
    expect(publishMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
    expect(callLog).toEqual(sessionIds.map((id) => `grade:${id}`))
  })

  it("swallows a grading rejection instead of propagating it", async () => {
    gradeMock.mockRejectedValueOnce(new Error("db down"))
    logErrorMock.mockClear()

    await expect(gradeSessions(["s1"])).resolves.toBeUndefined()
    expect(logErrorMock).toHaveBeenCalledTimes(1)
    expect(publishMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })
})

describe("regradeFlaggedSessions", () => {
  const findManyMock = vi.mocked(prisma.examSession.findMany)

  it("regrades only the matching sessions flagged needsRegrade", async () => {
    findManyMock.mockResolvedValueOnce([{ id: "s1" }, { id: "s2" }] as never)
    gradeMock.mockResolvedValue(undefined)

    await regradeFlaggedSessions({ examId: "e1" })

    expect(findManyMock).toHaveBeenCalledWith({
      where: { examId: "e1", needsRegrade: true },
      select: { id: true },
    })
    expect(gradeMock.mock.calls.map(([id]) => id).sort()).toEqual(["s1", "s2"])
  })

  it("grades nothing when no session is flagged", async () => {
    findManyMock.mockResolvedValueOnce([])

    await regradeFlaggedSessions({ id: "s1", userId: "u1" })

    expect(gradeMock).not.toHaveBeenCalled()
  })
})
