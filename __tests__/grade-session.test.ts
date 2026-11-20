import { describe, expect, it, vi, beforeEach } from "vitest"

const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
const executeRawMock = vi.fn()
const createManyMock = vi.fn()
const lockMock = vi.fn()
const dbMock = {
  examSession: {
    findUnique: (...args: unknown[]) => findUniqueMock(...args),
    updateMany: (...args: unknown[]) => updateManyMock(...args),
  },
  grade: { createMany: (...args: unknown[]) => createManyMock(...args) },
  $queryRaw: (...args: unknown[]) => lockMock(...args),
  $executeRaw: (...args: unknown[]) => executeRawMock(...args),
}
const transactionMock = vi.fn(
  async (callback: (db: typeof dbMock) => Promise<void>) => callback(dbMock)
)

vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
    grade: { createMany: (...args: unknown[]) => createManyMock(...args) },
    $executeRaw: (...args: unknown[]) => executeRawMock(...args),
    $transaction: (callback: (db: typeof dbMock) => Promise<void>) =>
      transactionMock(callback),
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
  return {
    questionId,
    content: { type: "MULTIPLE_CHOICE", selectedOptionIds: selected },
  }
}

beforeEach(() => {
  findUniqueMock.mockReset()
  updateManyMock.mockReset()
  updateManyMock.mockResolvedValue({ count: 0 })
  executeRawMock.mockReset()
  createManyMock.mockReset()
  transactionMock.mockClear()
  lockMock.mockReset()
})

describe("autoGradeSession", () => {
  it("clears needsRegrade under the session lock before reading answers", async () => {
    findUniqueMock.mockResolvedValue(null)
    await autoGradeSession(sessionId)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: sessionId, needsRegrade: true },
      data: { needsRegrade: false },
    })
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateManyMock.mock.invocationCallOrder[0]
    )
    // Lock acquisition precedes both the flag clear and answer read.
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUniqueMock.mock.invocationCallOrder[0]
    )
  })

  it("propagates grading failure so the transaction rolls back its flag clear", async () => {
    findUniqueMock.mockRejectedValue(new Error("db down"))
    await expect(autoGradeSession(sessionId)).rejects.toThrow("db down")
    // A single guarded updateMany (where needsRegrade: true) inside the
    // transaction: no compensating restore write is ever attempted, and the
    // rollback is the transaction's job.
    expect(updateManyMock).toHaveBeenCalledTimes(1)
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })

  it("opens a transaction and attempts only the flag clear when the session does not exist", async () => {
    findUniqueMock.mockResolvedValue(null)
    await autoGradeSession(sessionId)
    expect(executeRawMock).not.toHaveBeenCalled()
  })

  it("does nothing when there is nothing gradeable and no grades exist", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [],
      grades: [],
      exam: {
        questions: [{ id: "q1", type: "FREE_TEXT", points: 5, config: {} }],
      },
    })
    await autoGradeSession(sessionId)
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
      data: [
        {
          sessionId,
          questionId: "q1",
          points: 4,
          maxPoints: 4,
          autoGraded: true,
        },
      ],
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
      data: [
        {
          sessionId,
          questionId: "q1",
          points: 4,
          maxPoints: 4,
          autoGraded: true,
        },
      ],
      skipDuplicates: true,
    })
    // No second attempt / no throw — the caller (gradeWithRetry) sees a
    // clean success either way, which is correct: the grade already exists.
    expect(executeRawMock).not.toHaveBeenCalled()
  })

  it("splits mixed questions into create and update buckets in one transaction", async () => {
    findUniqueMock.mockResolvedValue({
      answers: [
        mcAnswer("q1", ["a"]),
        mcAnswer("q2", ["a"]),
        mcAnswer("q3", ["a"]),
      ],
      grades: [
        { questionId: "q1", autoGraded: true }, // -> update
        { questionId: "q2", autoGraded: false }, // -> skip
        // q3 has no grade row -> create
      ],
      exam: {
        questions: [mcQuestion("q1"), mcQuestion("q2"), mcQuestion("q3")],
      },
    })
    await autoGradeSession(sessionId)

    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(createManyMock).toHaveBeenCalledWith({
      data: [
        {
          sessionId,
          questionId: "q3",
          points: 4,
          maxPoints: 4,
          autoGraded: true,
        },
      ],
      skipDuplicates: true,
    })
  })
})
