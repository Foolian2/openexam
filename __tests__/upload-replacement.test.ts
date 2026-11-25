import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({
  examSession: vi.fn(),
  question: vi.fn(),
  questions: vi.fn(),
  answer: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
  budget: vi.fn(),
  refund: vi.fn(),
  storedBytes: vi.fn(),
  advisoryLock: vi.fn(),
  gate: vi.fn(),
  reread: vi.fn(),
}))
vi.mock("@/lib/api-auth", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "u1", role: "STUDENT" },
    session: { id: "auth-1" },
  })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: { findUnique: mocks.examSession },
    question: { findUnique: mocks.question, findMany: mocks.questions },
    answer: { findUnique: mocks.answer },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRaw: mocks.advisoryLock,
        $queryRaw: mocks.storedBytes,
        answerFile: {},
        examSession: { updateMany: mocks.gate, findUnique: mocks.reread },
      }),
  },
}))
vi.mock("@/lib/answer-files", () => ({
  storeAnswerFile: mocks.store,
  deleteAnswerFile: mocks.remove,
}))
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}))
vi.mock("@/lib/seb-guard", () => ({
  verifySebAccess: vi.fn(async () => ({ ok: true })),
}))
vi.mock("@/lib/seb-urls", () => ({
  publicRequestUrl: () => "https://localhost/upload",
}))
vi.mock("@/lib/redis", () => ({
  redis: { eval: mocks.budget, decrby: mocks.refund },
}))
import { POST } from "@/app/api/sessions/[id]/upload/route"
const oldKey = "sessions/s1/q1/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf"
const config = {
  maxFileSizeMB: 25,
  allowedExtensions: [".pdf"],
  instructions: "",
}
function upload() {
  const form = new FormData()
  form.append("questionId", "q1")
  form.append("file", new File(["new attachment"], "replacement.pdf"))
  return POST(
    new NextRequest("https://localhost/upload", { method: "POST", body: form }),
    { params: Promise.resolve({ id: "s1" }) }
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.examSession.mockResolvedValue({
    id: "s1",
    examId: "e1",
    userId: "u1",
    status: "IN_PROGRESS",
    effectiveEndTime: null,
    exam: {},
  })
  mocks.question.mockResolvedValue({
    id: "q1",
    examId: "e1",
    type: "FILE_UPLOAD",
    config,
  })
  mocks.questions.mockResolvedValue([{ type: "FILE_UPLOAD", config }])
  mocks.answer.mockResolvedValue({ content: { fileKey: oldKey } })
  mocks.store.mockResolvedValue(undefined)
  mocks.budget.mockResolvedValue(20)
  mocks.storedBytes.mockResolvedValue([{ bytes: null }])
  mocks.advisoryLock.mockResolvedValue(1)
  mocks.gate.mockResolvedValue({ count: 1 })
})
describe("replacement upload durability", () => {
  it("keeps the previously saved attachment when a replacement is only uploaded", async () => {
    const res = await upload()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.fileKey).not.toBe(oldKey)
    expect(mocks.store).toHaveBeenCalledOnce()
    // Upload does not commit the answer pointer: autosave can fail, be offline,
    // or lose a sequence race. Deleting the referenced file here loses work.
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it("does not delete saved work when two replacements race", async () => {
    const res = await Promise.all([upload(), upload()])
    expect(res.map((r) => r.status)).toEqual([200, 200])
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it("refunds the budget on storage failure and preserves the old file", async () => {
    mocks.store.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(upload()).rejects.toThrow("database unavailable")
    expect(mocks.refund).toHaveBeenCalledOnce()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("refuses and refunds when stored bytes in Postgres already fill the budget", async () => {
    // The Redis counter can be gone (48 h expiry, flush) while the bytes
    // remain; the durable sum still enforces the 512 MB floor budget.
    mocks.storedBytes.mockResolvedValue([{ bytes: BigInt(512 * 1024 * 1024) }])
    const res = await upload()
    expect(res.status).toBe(429)
    expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED")
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.refund).toHaveBeenCalledOnce()
  })

  it("rolls back stored bytes when a takeover wins and refunds the budget", async () => {
    mocks.gate.mockResolvedValue({ count: 0 })
    mocks.reread.mockResolvedValue({ activeAuthSessionId: "auth-2" })
    const res = await upload()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("SESSION_REPLACED")
    // The insert ran on the transaction client, so the gate's throw rolls
    // it back with the transaction.
    expect(mocks.store.mock.calls[0][4]).toBeDefined()
    expect(mocks.refund).toHaveBeenCalledOnce()
  })

  it("counts stored bytes and inserts under a per-session advisory lock", async () => {
    const order: string[] = []
    mocks.advisoryLock.mockImplementation(async () => {
      order.push("lock")
      return 1
    })
    mocks.storedBytes.mockImplementation(async () => {
      order.push("sum")
      return [{ bytes: null }]
    })
    mocks.store.mockImplementation(async () => {
      order.push("insert")
    })
    mocks.gate.mockImplementation(async () => {
      order.push("gate")
      return { count: 1 }
    })
    const res = await upload()
    expect(res.status).toBe(200)
    // The session row lock (the gate) is taken last, so a large insert
    // does not hold up answer flushes, autosaves or takeover claims.
    expect(order).toEqual(["lock", "sum", "insert", "gate"])
    const lockSql = mocks.advisoryLock.mock.calls[0][0] as {
      join?: (s: string) => string
    } & string[]
    expect(Array.from(lockSql).join("?")).toContain("pg_advisory_xact_lock")
    expect(mocks.advisoryLock.mock.calls[0]).toContain("answer-upload:s1")
    // The insert runs on the transaction client, inside the lock.
    expect(mocks.store.mock.calls[0][4]).toBeDefined()
  })
})
