import { beforeEach, describe, expect, it, vi } from "vitest"

const answerFile = {
  create: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
}
vi.mock("@/lib/prisma", () => ({ prisma: { answerFile } }))

const { storeAnswerFile, readAnswerFile, deleteAnswerFile } = await import(
  "@/lib/answer-files"
)

const key = "sessions/s1/q1/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf"

beforeEach(() => vi.clearAllMocks())

describe("answer-files", () => {
  it("stores the bytes with their size under the session and question", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    await storeAnswerFile(key, "s1", "q1", bytes)
    expect(answerFile.create).toHaveBeenCalledWith({
      data: { key, sessionId: "s1", questionId: "q1", sizeBytes: 3, data: bytes },
    })
  })

  it("reads only a file belonging to the given session and question", async () => {
    answerFile.findFirst.mockResolvedValueOnce(null)
    expect(await readAnswerFile(key, "s2", "q1")).toBeNull()
    expect(answerFile.findFirst).toHaveBeenCalledWith({
      where: { key, sessionId: "s2", questionId: "q1" },
      select: { data: true },
    })
  })

  it("deletes scoped to the session and question, never by key alone", async () => {
    await deleteAnswerFile(key, "s1", "q1")
    expect(answerFile.deleteMany).toHaveBeenCalledWith({
      where: { key, sessionId: "s1", questionId: "q1" },
    })
  })
})
