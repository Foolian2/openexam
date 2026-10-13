import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, auditLogMock, rawMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    questionBankItem: { findUnique: vi.fn() },
    question: { findMany: vi.fn(), updateMany: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
  auditLogMock: { createAuditLog: vi.fn() },
  rawMock: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))

const BANK_ID = "c000000000000000000000004"
const EXAM_1 = "c000000000000000000000005"
const EXAM_2 = "c000000000000000000000006"
const params = Promise.resolve({ id: BANK_ID })

const bankItem = {
  id: BANK_ID,
  creatorId: "teacher1",
  type: "SHORT_ANSWER",
  title: "Hauptstadt der Schweiz?",
  points: 1,
  required: true,
  config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 100 },
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
  prismaMock.$transaction.mockImplementation((callback) =>
    callback({ $queryRaw: rawMock, question: prismaMock.question })
  )
  rawMock.mockResolvedValue([])
})

describe("POST /api/question-bank/[id]/propagate", () => {
  it("rejects non-teacher roles", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", role: "STUDENT" },
    })
    const { POST } =
      await import("@/app/api/question-bank/[id]/propagate/route")
    const res = await POST(
      new NextRequest("http://localhost/api/question-bank/bank1/propagate", {
        method: "POST",
      }),
      { params }
    )
    expect(res.status).toBe(403)
    expect(prismaMock.question.updateMany).not.toHaveBeenCalled()
  })

  it("rejects items the caller does not own", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      ...bankItem,
      creatorId: "teacher2",
    })
    const { POST } =
      await import("@/app/api/question-bank/[id]/propagate/route")
    const res = await POST(
      new NextRequest("http://localhost/api/question-bank/bank1/propagate", {
        method: "POST",
      }),
      { params }
    )
    expect(res.status).toBe(404)
    expect(prismaMock.question.updateMany).not.toHaveBeenCalled()
  })

  it("returns 0 when no copies exist in editable exams", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
    prismaMock.question.findMany.mockResolvedValue([])

    const { POST } =
      await import("@/app/api/question-bank/[id]/propagate/route")
    const res = await POST(
      new NextRequest("http://localhost/api/question-bank/bank1/propagate", {
        method: "POST",
      }),
      { params }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 0, exams: [] })
    expect(prismaMock.question.updateMany).not.toHaveBeenCalled()
    expect(auditLogMock.createAuditLog).not.toHaveBeenCalled()
  })

  it("only ever targets DRAFT/PUBLISHED exams the owner created, never ACTIVE or closed ones", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
    rawMock.mockResolvedValue([
      { id: EXAM_1, creatorId: "teacher1", status: "PUBLISHED" },
    ])
    prismaMock.question.findMany.mockResolvedValue([{ examId: EXAM_1 }])
    prismaMock.question.updateMany.mockResolvedValue({ count: 1 })

    const { POST } =
      await import("@/app/api/question-bank/[id]/propagate/route")
    await POST(
      new NextRequest("http://localhost/api/question-bank/bank1/propagate", {
        method: "POST",
      }),
      { params }
    )

    expect(rawMock).toHaveBeenCalledOnce()
    expect(rawMock.mock.calls[0][0].text).toContain('"Question"')
    expect(rawMock.mock.calls[0][0].text).toContain("FOR UPDATE")
    // Parent locks serialize the update against activation. Writes are
    // limited to owner exams whose status was still editable under lock.
    expect(prismaMock.question.updateMany).toHaveBeenCalledWith({
      where: {
        bankItemId: BANK_ID,
        examId: { in: [EXAM_1] },
      },
      data: expect.objectContaining({
        title: "Hauptstadt der Schweiz?",
        config: bankItem.config,
      }),
    })
  })

  it("writes one audit row per affected exam with per-exam copy counts", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
    rawMock.mockResolvedValue([
      { id: EXAM_1, creatorId: "teacher1", status: "PUBLISHED" },
      { id: EXAM_2, creatorId: "teacher1", status: "PUBLISHED" },
    ])
    prismaMock.question.findMany.mockResolvedValue([
      { examId: EXAM_1 },
      { examId: EXAM_1 },
      { examId: EXAM_2 },
    ])
    prismaMock.question.updateMany.mockResolvedValue({ count: 3 })

    const { POST } =
      await import("@/app/api/question-bank/[id]/propagate/route")
    const res = await POST(
      new NextRequest("http://localhost/api/question-bank/bank1/propagate", {
        method: "POST",
      }),
      { params }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 3, exams: [EXAM_1, EXAM_2] })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledTimes(2)
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_ITEM_PROPAGATED",
        entityId: BANK_ID,
        examId: EXAM_1,
        metadata: { bankItemId: BANK_ID, updatedCopies: 2 },
      })
    )
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        examId: EXAM_2,
        metadata: { bankItemId: BANK_ID, updatedCopies: 1 },
      })
    )
  })

  it("does not propagate into an exam that is ACTIVE when its row is locked", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
    // The ordered lock query sees EXAM_2 after activation and excludes it
    // before any question update.
    rawMock.mockResolvedValue([
      { id: EXAM_1, creatorId: "teacher1", status: "PUBLISHED" },
      { id: EXAM_2, creatorId: "teacher1", status: "ACTIVE" },
    ])
    prismaMock.question.findMany.mockResolvedValue([{ examId: EXAM_1 }])
    prismaMock.question.updateMany.mockResolvedValue({ count: 1 })

    const { POST } =
      await import("@/app/api/question-bank/[id]/propagate/route")
    const res = await POST(
      new NextRequest("http://localhost/api/question-bank/bank1/propagate", {
        method: "POST",
      }),
      { params }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 1, exams: [EXAM_1] })
    expect(rawMock).toHaveBeenCalledOnce()
    expect(prismaMock.question.updateMany).toHaveBeenCalledWith({
      where: { bankItemId: BANK_ID, examId: { in: [EXAM_1] } },
      data: expect.any(Object),
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledTimes(1)
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ examId: EXAM_1 })
    )
  })
})
