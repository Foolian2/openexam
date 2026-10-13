import { describe, expect, it, vi, beforeEach } from "vitest"

const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
const executeRawMock = vi.fn()
const createManyMock = vi.fn()
const transactionMock = vi.fn(async (ops: unknown[]) => Promise.all(ops))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
    grade: { createMany: (...args: unknown[]) => createManyMock(...args) },
    $executeRaw: (...args: unknown[]) => executeRawMock(...args),
    $transaction: (ops: unknown[]) => transactionMock(ops),
  },
}))

import { autoGradeSession } from "@/lib/grading/grade-session"

const sessionId = "session-1"

function mcQuestion(id: string, points = 4) {
  return {
    id,
    type: "MULTIPLE_CHOICE",
    points,
    config: {
      multiSelect: false,
      options: [
        { id: "a", text: "A", isCorrect: true },
        { id: "b", text: "B", isCorrect: false },
      ],
    },
  }
}

function mcAnswer(questionId: string, selected: string[]) {
  return { questionId, content: { type: "MULTIPLE_CHOICE", selectedOptionIds: selected } }
}

beforeEach(() => {
  findUniqueMock.mockReset()
  updateManyMock.mockReset()
  updateManyMock.mockResolvedValue({ count: 0 })
  executeRawMock.mockReset()
  createManyMock.mockReset()
  transactionMock.mockClear()
})

describe("autoGradeSession", () => {
  it("clears needsRegrade before reading the answers it grades", async () => {
    findUniqueMock.mockResolvedValue(null)
    await autoGradeSession(sessionId)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: sessionId, needsRegrade: true },
      data: { needsRegrade: false },
    })
    // A late answer flushed after the read re-sets the flag; clearing it
    // after the read instead would silently drop that signal.
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueMock.mock.invocationCallOrder[0]
    )
  })

  it("restores needsRegrade when grading fails after clearing it", async () => {
    updateManyMock.mockResolvedValue({ count: 1 })
    findUniqueMock.mockRejectedValue(new Error("db down"))
    await expect(autoGradeSession(sessionId)).rejects.toThrow("db down")
    expect(updateManyMock).toHaveBeenLastCalledWith({
      where: { id: sessionId },
      data: { needsRegrade: true },
    })
  })

  it("does not set needsRegrade on failure when it was not set before", async () => {
    findUniqueMock.mockRejectedValue(new Error("db down"))
    await expect(autoGradeSession(sessionId)).rejects.toThrow("db down")
    expect(updateManyMock).toHaveBeenCalledTimes(1)
  })

  it("does nothing when the session does not exist", async () => {
    findUniqueMock.mockResolvedValue(null)
    await autoGradeSession(sessionId)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("does nothing when there is nothing gradeable and no grades exist", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [],
      grades: [],
      exam: { questions: [{ id: "q1", type: "FREE_TEXT", points: 5, config: {} }] },
    })
    await autoGradeSession(sessionId)
    expect(transactionMock).not.toHaveBeenCalled()
    expect(executeRawMock).not.toHaveBeenCalled()
    expect(createManyMock).not.toHaveBeenCalled()
  })

  it("creates a Grade row for a gradeable question with no existing grade", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [mcAnswer("q1", ["a"])],
      grades: [],
      exam: { questions: [mcQuestion("q1")] },
    })
    await autoGradeSession(sessionId)

    expect(createManyMock).toHaveBeenCalledTimes(1)
    expect(createManyMock).toHaveBeenCalledWith({
      data: [{ sessionId, questionId: "q1", points: 4, maxPoints: 4, autoGraded: true }],
      skipDuplicates: true,
    })
    expect(executeRawMock).not.toHaveBeenCalled()
  })

  it("bulk-updates existing autoGraded rows via a single raw statement", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [mcAnswer("q1", ["a"]), mcAnswer("q2", ["a"])],
      grades: [
        { questionId: "q1", autoGraded: true },
        { questionId: "q2", autoGraded: true },
      ],
      exam: { questions: [mcQuestion("q1", 4), mcQuestion("q2", 2)] },
    })
    await autoGradeSession(sessionId)

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(createManyMock).not.toHaveBeenCalled()

    // Prisma.sql/Prisma.join are real (unmocked) — the resulting Sql
    // fragment's public `.values` getter carries every interpolated value in
    // order: both rows' (questionId, points, maxPoints) triples from the
    // VALUES list, followed by sessionId from the WHERE clause.
    const [, valuesFragment, sessionIdArg] = executeRawMock.mock.calls[0] as [
      unknown,
      { values: unknown[] },
      unknown,
    ]
    expect(valuesFragment.values).toEqual(["q1", 4, 4, "q2", 2, 2])
    expect(sessionIdArg).toBe(sessionId)
  })

  it("never touches a manually graded question (autoGraded: false)", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [mcAnswer("q1", ["a"])],
      grades: [{ questionId: "q1", autoGraded: false }],
      exam: { questions: [mcQuestion("q1")] },
    })
    await autoGradeSession(sessionId)

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(createManyMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("does not throw or attempt to recover when a concurrent manual grade wins the UPDATE race ($executeRaw matches 0 rows)", async () => {
    // Simulates: a teacher manually grades q1 (flipping autoGraded to false)
    // in between the read above and this write. The WHERE ... AND
    // "autoGraded" = true predicate then matches nothing — Postgres reports
    // 0 rows affected — and autoGradeSession must treat that as a normal,
    // successful no-op rather than retrying or surfacing an error.
    executeRawMock.mockResolvedValue(0)
    findUniqueMock.mockResolvedValue({
      answers: [mcAnswer("q1", ["a"])],
      grades: [{ questionId: "q1", autoGraded: true }],
      exam: { questions: [mcQuestion("q1")] },
    })

    await expect(autoGradeSession(sessionId)).resolves.toBeUndefined()

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(transactionMock).toHaveBeenCalledTimes(1)
    // No compensating write is attempted after the raw UPDATE reports 0 rows.
    expect(createManyMock).not.toHaveBeenCalled()
  })

  it("does not throw or attempt to recover when createMany's skipDuplicates drops every row (concurrent insert already won)", async () => {
    // Simulates: a concurrent grade write (e.g. another finalize path) already
    // created the Grade row(s) for the same (sessionId, questionId) between
    // the read and the write, so skipDuplicates makes createMany a no-op.
    createManyMock.mockResolvedValue({ count: 0 })
    findUniqueMock.mockResolvedValue({
      answers: [mcAnswer("q1", ["a"])],
      grades: [],
      exam: { questions: [mcQuestion("q1")] },
    })

    await expect(autoGradeSession(sessionId)).resolves.toBeUndefined()

    expect(createManyMock).toHaveBeenCalledTimes(1)
    expect(createManyMock).toHaveBeenCalledWith({
      data: [{ sessionId, questionId: "q1", points: 4, maxPoints: 4, autoGraded: true }],
      skipDuplicates: true,
    })
    // No second attempt / no throw — the caller (gradeWithRetry) sees a
    // clean success either way, which is correct: the grade already exists.
    expect(executeRawMock).not.toHaveBeenCalled()
  })

  it("splits mixed questions into create and update buckets in one transaction", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [mcAnswer("q1", ["a"]), mcAnswer("q2", ["a"]), mcAnswer("q3", ["a"])],
      grades: [
        { questionId: "q1", autoGraded: true }, // -> update
        { questionId: "q2", autoGraded: false }, // -> skip
        // q3 has no grade row -> create
      ],
      exam: { questions: [mcQuestion("q1"), mcQuestion("q2"), mcQuestion("q3")] },
    })
    await autoGradeSession(sessionId)

    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(createManyMock).toHaveBeenCalledWith({
      data: [{ sessionId, questionId: "q3", points: 4, maxPoints: 4, autoGraded: true }],
      skipDuplicates: true,
    })
  })
})
