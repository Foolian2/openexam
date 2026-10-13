import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/redis", () => ({
  redis: { hmget: vi.fn() },
}))
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { answer: { findMany: vi.fn() } },
}))

const { redis } = await import("@/lib/redis")
const { prisma } = await import("@/lib/prisma")
const {
  loadSessionAnswers,
  overlayBufferedAnswers,
  readBufferedAnswers,
  wsAnswerField,
  wsAnswersHashKey,
} = await import("@/lib/ws-answer-buffer")

const hmget = vi.mocked(redis.hmget)
const findMany = vi.mocked(prisma.answer.findMany)

const tf = (selected: boolean) => ({ type: "TRUE_FALSE" as const, selected })

beforeEach(() => {
  hmget.mockReset()
  findMany.mockReset()
})

describe("ws answer buffer keys", () => {
  it("match ws-backend's answersHashKey and fieldKey", () => {
    expect(wsAnswersHashKey("e1")).toBe("exam:e1:answers")
    expect(wsAnswerField("s1", "q1")).toBe("s1:q1")
  })
})

describe("readBufferedAnswers", () => {
  it("returns parsed entries for the session's questions", async () => {
    hmget.mockResolvedValue([
      JSON.stringify({
        sessionId: "s1",
        questionId: "q1",
        content: tf(true),
        clientSeq: 7,
      }),
      null,
    ])
    const out = await readBufferedAnswers("e1", "s1", ["q1", "q2"])
    expect(hmget).toHaveBeenCalledWith("exam:e1:answers", "s1:q1", "s1:q2")
    expect(out).toEqual([{ questionId: "q1", content: tf(true), clientSeq: 7 }])
  })

  it("keeps entries from clients without a sequence number", async () => {
    hmget.mockResolvedValue([JSON.stringify({ content: tf(false) })])
    expect(await readBufferedAnswers("e1", "s1", ["q1"])).toEqual([
      { questionId: "q1", content: tf(false), clientSeq: null },
    ])
  })

  it("skips malformed and invalid entries", async () => {
    hmget.mockResolvedValue([
      "{not json",
      JSON.stringify({ content: { type: "NOPE" } }),
    ])
    expect(await readBufferedAnswers("e1", "s1", ["q1", "q2"])).toEqual([])
  })

  it("fails open when Redis is unavailable", async () => {
    hmget.mockRejectedValue(new Error("ECONNREFUSED"))
    expect(await readBufferedAnswers("e1", "s1", ["q1"])).toEqual([])
  })

  it("does not query Redis for an exam without questions", async () => {
    expect(await readBufferedAnswers("e1", "s1", [])).toEqual([])
    expect(hmget).not.toHaveBeenCalled()
  })
})

describe("overlayBufferedAnswers", () => {
  const stored = (clientSeq: number | null, selected = false) => ({
    questionId: "q1",
    content: tf(selected),
    clientSeq,
    version: 2,
  })

  it("adds an answer that only exists in the buffer", () => {
    const out = overlayBufferedAnswers(
      [],
      [{ questionId: "q1", content: tf(true), clientSeq: 3 }]
    )
    expect(out).toEqual([{ questionId: "q1", content: tf(true), clientSeq: 3 }])
  })

  it("lets a newer buffered answer replace the stored one", () => {
    const out = overlayBufferedAnswers(
      [stored(3)],
      [{ questionId: "q1", content: tf(true), clientSeq: 4 }]
    )
    expect(out).toEqual([
      { questionId: "q1", content: tf(true), clientSeq: 4, version: 2 },
    ])
  })

  it("keeps the stored answer when it is as new or newer", () => {
    for (const seq of [4, 5]) {
      const out = overlayBufferedAnswers(
        [stored(seq)],
        [{ questionId: "q1", content: tf(true), clientSeq: 4 }]
      )
      expect(out).toEqual([stored(seq)])
    }
  })

  it("lets the buffer win when either side is unsequenced, like the flusher", () => {
    expect(
      overlayBufferedAnswers(
        [stored(9)],
        [{ questionId: "q1", content: tf(true), clientSeq: null }]
      )[0]!.content
    ).toEqual(tf(true))
    expect(
      overlayBufferedAnswers(
        [stored(null)],
        [{ questionId: "q1", content: tf(true), clientSeq: 1 }]
      )[0]!.content
    ).toEqual(tf(true))
  })

  it("leaves other questions untouched", () => {
    const other = { ...stored(1), questionId: "q2" }
    const out = overlayBufferedAnswers(
      [other],
      [{ questionId: "q1", content: tf(true), clientSeq: 1 }]
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(other)
  })
})

describe("loadSessionAnswers", () => {
  const args = {
    examId: "e1",
    sessionId: "s1",
    questionIds: ["q1"],
  }

  it("reads the buffer before the Postgres snapshot", async () => {
    // The flusher deletes a buffer field only after committing it, so this
    // order can't miss an answer that moves from Redis to Postgres between
    // the two reads.
    const order: string[] = []
    hmget.mockImplementation(async () => {
      order.push("redis")
      return [JSON.stringify({ content: tf(true), clientSeq: 5 })] as never
    })
    findMany.mockImplementation((async () => {
      order.push("postgres")
      return [
        { questionId: "q1", content: tf(false), clientSeq: 4, version: 1 },
      ]
    }) as never)

    const out = await loadSessionAnswers({ ...args, live: true })
    expect(order).toEqual(["redis", "postgres"])
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: "s1" } })
    )
    expect(out).toEqual([
      { questionId: "q1", content: tf(true), clientSeq: 5, version: 1 },
    ])
  })

  it("skips the buffer for a session that is no longer live", async () => {
    findMany.mockResolvedValue([] as never)
    expect(await loadSessionAnswers({ ...args, live: false })).toEqual([])
    expect(hmget).not.toHaveBeenCalled()
  })
})
