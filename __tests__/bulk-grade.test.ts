import { describe, expect, it, vi, beforeEach } from "vitest"

const findUniqueMock = vi.fn()
const findManyMock = vi.fn()
const createManyMock = vi.fn()
const upsertMock = vi.fn()
const updateManyMock = vi.fn()
const transactionMock = vi.fn(async (ops: unknown[]) => Promise.all(ops))
const createAuditLogMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    exam: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
    examSession: { findMany: (...args: unknown[]) => findManyMock(...args) },
    grade: {
      createMany: (...args: unknown[]) => createManyMock(...args),
      upsert: (...args: unknown[]) => upsertMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
    $transaction: (ops: unknown[]) => transactionMock(ops),
  },
}))
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => createAuditLogMock(...args),
}))

import { applyBulkGrade } from "@/lib/grading/bulk-grade"

const examId = "exam1"
const teacherId = "teacher1"

function exam(overrides: Partial<{ status: string; creatorId: string }> = {}) {
  return {
    id: examId,
    creatorId: teacherId,
    status: "CLOSED",
    questions: [
      { id: "q1", points: 4 },
      { id: "q2", points: 6 },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  findUniqueMock.mockReset()
  findManyMock.mockReset()
  createManyMock.mockReset()
  createManyMock.mockResolvedValue({ count: 0 })
  upsertMock.mockReset()
  upsertMock.mockResolvedValue({})
  updateManyMock.mockReset()
  updateManyMock.mockResolvedValue({ count: 0 })
  transactionMock.mockClear()
  createAuditLogMock.mockReset()
  createAuditLogMock.mockResolvedValue(undefined)
})

describe("applyBulkGrade — ZERO_UNGRADED", () => {
  it("denies when the exam doesn't exist or belongs to another teacher", async () => {
    findUniqueMock.mockResolvedValue(null)
    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "ZERO_UNGRADED" },
    })
    expect(result).toEqual({ ok: false, reason: "not_found" })
    expect(findManyMock).not.toHaveBeenCalled()
  })

  it("denies when the exam is not CLOSED", async () => {
    findUniqueMock.mockResolvedValue(exam({ status: "ACTIVE" }))
    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "ZERO_UNGRADED" },
    })
    expect(result).toEqual({ ok: false, reason: "not_closed" })
    expect(findManyMock).not.toHaveBeenCalled()
  })

  it("creates a 0-point grade only for questions a session hasn't been graded on yet", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [{ questionId: "q1" }] }, // q2 still ungraded
      { id: "s2", grades: [] }, // both ungraded
    ])
    createManyMock.mockResolvedValue({ count: 3 }) // all 3 rows actually written

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1", "s2"],
      action: { action: "ZERO_UNGRADED" },
    })

    expect(result).toEqual({ ok: true, sessionsAffected: 2, gradesCreated: 3 })
    expect(createManyMock).toHaveBeenCalledWith({
      data: [
        {
          sessionId: "s1",
          questionId: "q2",
          points: 0,
          maxPoints: 6,
          autoGraded: false,
          gradedById: teacherId,
        },
        {
          sessionId: "s2",
          questionId: "q1",
          points: 0,
          maxPoints: 4,
          autoGraded: false,
          gradedById: teacherId,
        },
        {
          sessionId: "s2",
          questionId: "q2",
          points: 0,
          maxPoints: 6,
          autoGraded: false,
          gradedById: teacherId,
        },
      ],
      skipDuplicates: true,
    })
  })

  it("never touches already-graded questions, including auto-graded ones", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [{ questionId: "q1" }, { questionId: "q2" }] },
    ])

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "ZERO_UNGRADED" },
    })

    expect(result).toEqual({ ok: true, sessionsAffected: 1, gradesCreated: 0 })
    expect(createManyMock).not.toHaveBeenCalled()
  })

  it("skips sessionIds that don't belong to this exam or aren't submitted — filtered at the query level", async () => {
    findUniqueMock.mockResolvedValue(exam())
    // The query itself filters by examId + status; simulate that only one of
    // the two requested ids came back.
    findManyMock.mockResolvedValue([{ id: "s1", grades: [] }])

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1", "s-from-another-exam"],
      action: { action: "ZERO_UNGRADED" },
    })

    expect(result.ok && result.sessionsAffected).toBe(1)
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["s1", "s-from-another-exam"] },
          examId,
          status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
        }),
      })
    )
  })

  it("writes exactly one audit log row per bulk operation, not one per session", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [] },
      { id: "s2", grades: [] },
      { id: "s3", grades: [] },
    ])
    createManyMock.mockResolvedValue({ count: 6 }) // all 6 rows actually written

    await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1", "s2", "s3"],
      action: { action: "ZERO_UNGRADED" },
    })

    expect(createAuditLogMock).toHaveBeenCalledTimes(1)
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BULK_GRADE_APPLIED",
        entityType: "Exam",
        entityId: examId,
        metadata: {
          action: "ZERO_UNGRADED",
          sessionCount: 3,
          gradesCreated: 6,
        },
      })
    )
  })

  it("reports the real createMany write count, not the pre-write intent, when a concurrent auto-grade wins some rows (skipDuplicates)", async () => {
    // Regression test for a real bug: applyBulkGrade used to report
    // missing.length (what it *intended* to write) instead of createMany's
    // actual `{ count }` result. If a concurrent auto-grade created some of
    // these Grade rows between the read and the write, skipDuplicates
    // silently drops those inserts — the return value and audit log must
    // reflect what was really created, not the stale pre-write intent.
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [{ questionId: "q1" }] }, // q2 still ungraded
      { id: "s2", grades: [] }, // both ungraded
    ])
    // 3 rows attempted (s1/q2, s2/q1, s2/q2), but only 2 actually landed —
    // a concurrent auto-grade already created one of them.
    createManyMock.mockResolvedValue({ count: 2 })

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1", "s2"],
      action: { action: "ZERO_UNGRADED" },
    })

    expect(result).toEqual({ ok: true, sessionsAffected: 2, gradesCreated: 2 })
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          action: "ZERO_UNGRADED",
          sessionCount: 2,
          gradesCreated: 2,
        },
      })
    )
  })
})

describe("applyBulkGrade — SET_POINTS", () => {
  it("rejects points above the question's max", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([{ id: "s1", grades: [] }])

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "SET_POINTS", questionId: "q1", points: 5 }, // q1 max is 4
    })

    expect(result).toEqual({ ok: false, reason: "invalid_points" })
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it("rejects an unknown questionId", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([{ id: "s1", grades: [] }])

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "SET_POINTS", questionId: "q-nope", points: 1 },
    })

    expect(result).toEqual({ ok: false, reason: "question_not_found" })
  })

  it("upserts the same points/feedback for every filtered session, creating rows for gaps", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [] },
      { id: "s2", grades: [] },
    ])

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1", "s2"],
      action: {
        action: "SET_POINTS",
        questionId: "q1",
        points: 3,
        feedback: "Gut",
      },
    })

    expect(result).toEqual({
      ok: true,
      sessionsAffected: 2,
      gradesCreated: 0,
      gradesUpdated: 2,
    })
    expect(transactionMock).toHaveBeenCalledTimes(1)
    expect(upsertMock).toHaveBeenCalledTimes(2)
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId_questionId: { sessionId: "s1", questionId: "q1" } },
        create: expect.objectContaining({
          points: 3,
          maxPoints: 4,
          feedback: "Gut",
          autoGraded: false,
          gradedById: teacherId,
        }),
        update: expect.objectContaining({
          points: 3,
          maxPoints: 4,
          feedback: "Gut",
          autoGraded: false,
          gradedById: teacherId,
        }),
      })
    )
  })

  it("does not touch reviewedAt/reviewedById on the update branch", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [{ questionId: "q1" }] },
    ])

    await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "SET_POINTS", questionId: "q1", points: 2 },
    })

    const call = upsertMock.mock.calls[0][0]
    expect(call.update).not.toHaveProperty("reviewedAt")
    expect(call.update).not.toHaveProperty("reviewedById")
  })
})

describe("applyBulkGrade — MARK_REVIEWED", () => {
  it("rejects an unknown questionId", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([{ id: "s1", grades: [] }])

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "MARK_REVIEWED", questionId: "q-nope" },
    })

    expect(result).toEqual({ ok: false, reason: "question_not_found" })
  })

  it("only updates rows scoped to autoGraded: true for the filtered sessions", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([
      { id: "s1", grades: [] },
      { id: "s2", grades: [] },
    ])
    updateManyMock.mockResolvedValue({ count: 1 })

    const result = await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1", "s2"],
      action: { action: "MARK_REVIEWED", questionId: "q1" },
    })

    expect(result).toEqual({ ok: true, sessionsAffected: 2, gradesCreated: 0 })
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        questionId: "q1",
        sessionId: { in: ["s1", "s2"] },
        autoGraded: true,
      },
      data: expect.objectContaining({ reviewedById: teacherId }),
    })
  })

  it("never calls grade.upsert or createMany — MARK_REVIEWED can only update existing rows", async () => {
    findUniqueMock.mockResolvedValue(exam())
    findManyMock.mockResolvedValue([{ id: "s1", grades: [] }])

    await applyBulkGrade({
      examId,
      teacherId,
      sessionIds: ["s1"],
      action: { action: "MARK_REVIEWED", questionId: "q1" },
    })

    expect(upsertMock).not.toHaveBeenCalled()
    expect(createManyMock).not.toHaveBeenCalled()
  })
})
