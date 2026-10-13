import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  evalScript: vi.fn(),
  hkeys: vi.fn(),
  queryRaw: vi.fn(),
  inc: vi.fn(),
}))
vi.mock("@/lib/redis", () => ({
  redis: { set: mocks.set, eval: mocks.evalScript, hkeys: mocks.hkeys },
}))
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: mocks.queryRaw } }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }))
vi.mock("@/lib/metrics", () => ({
  answerFilesPruned: { inc: mocks.inc },
  answerFileBytesPruned: { inc: mocks.inc },
}))

import {
  RETENTION_SETTLE_MS,
  sweepSupersededAnswerFiles,
} from "@/lib/answer-file-retention"

const now = new Date("2026-10-06T12:00:00Z")
const sqlText = (call: unknown[]) =>
  (call[0] as { strings: string[] }).strings.join("?")

beforeEach(() => {
  vi.resetAllMocks()
  mocks.set.mockResolvedValue("OK")
  mocks.evalScript.mockResolvedValue(1)
  mocks.hkeys.mockResolvedValue([])
})

describe("sweepSupersededAnswerFiles", () => {
  it("does nothing while another replica holds the lease", async () => {
    mocks.set.mockResolvedValue(null)
    expect(await sweepSupersededAnswerFiles(now)).toBe(0)
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it("selects only settled submitted sessions and unreferenced keys", async () => {
    mocks.queryRaw.mockResolvedValueOnce([])
    await sweepSupersededAnswerFiles(now)
    const select = mocks.queryRaw.mock.calls[0]
    const text = sqlText(select)
    expect(text).toContain('"deadlineFinalizationPending" = false')
    expect(text).toContain(`a."content"->>'fileKey' = f."key"`)
    const values = (select[0] as { values: unknown[] }).values
    expect(values).toEqual(
      expect.arrayContaining([
        "SUBMITTED",
        "AUTO_SUBMITTED",
        new Date(now.getTime() - RETENTION_SETTLE_MS),
      ])
    )
    expect(values).not.toContain("IN_PROGRESS")
    expect(values).not.toContain("LOCKED")
  })

  it("skips sessions whose answers are still in the WS buffer and re-checks in the DELETE", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([
        { key: "k-busy", sessionId: "s-busy", examId: "e1" },
        { key: "k-idle", sessionId: "s-idle", examId: "e1" },
      ])
      .mockResolvedValueOnce([{ sizeBytes: 1000 }])
    mocks.hkeys.mockResolvedValue(["s-busy:q1"])
    expect(await sweepSupersededAnswerFiles(now)).toBe(1)
    expect(mocks.hkeys).toHaveBeenCalledWith("exam:e1:answers")
    const del = mocks.queryRaw.mock.calls[1]
    expect(sqlText(del)).toContain('DELETE FROM "AnswerFile"')
    expect(sqlText(del)).toContain(`a."content"->>'fileKey' = f."key"`)
    const values = (del[0] as { values: unknown[] }).values
    expect(values).toContain("k-idle")
    expect(values).not.toContain("k-busy")
    expect(mocks.inc).toHaveBeenCalledWith(1)
    expect(mocks.inc).toHaveBeenCalledWith(1000)
  })

  it("deletes nothing and releases its lease when the buffer can't be read", async () => {
    mocks.queryRaw.mockResolvedValueOnce([
      { key: "k", sessionId: "s", examId: "e1" },
    ])
    mocks.hkeys.mockRejectedValue(new Error("redis down"))
    await expect(sweepSupersededAnswerFiles(now)).rejects.toThrow("redis down")
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
    expect(mocks.evalScript).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("DEL", KEYS[1])'),
      1,
      "answer-file-retention:lock",
      mocks.set.mock.calls[0][1]
    )
  })

  it("moves past a full batch of busy sessions instead of starving the rest", async () => {
    const busyBatch = Array.from({ length: 200 }, (_, i) => ({
      key: `busy-${i}`,
      sessionId: "s-busy",
      examId: "e1",
    }))
    mocks.queryRaw
      .mockResolvedValueOnce(busyBatch) // batch 1: all busy, nothing deleted
      .mockResolvedValueOnce([
        { key: "k-idle", sessionId: "s-idle", examId: "e1" },
      ])
      .mockResolvedValueOnce([{ sizeBytes: 10 }]) // delete of k-idle
    mocks.hkeys.mockResolvedValue(["s-busy:q1"])
    expect(await sweepSupersededAnswerFiles(now)).toBe(1)
    const second = mocks.queryRaw.mock.calls[1]
    expect(sqlText(second)).toContain('f."sessionId" NOT IN')
    expect((second[0] as { values: unknown[] }).values).toContain("s-busy")
    expect(
      (mocks.queryRaw.mock.calls[2][0] as { values: unknown[] }).values
    ).toContain("k-idle")
  })
})
