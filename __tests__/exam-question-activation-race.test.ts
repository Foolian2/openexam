import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, staffMock, auditMock, redisMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    exam: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    question: { count: vi.fn() },
  },
  staffMock: { requireStaff: vi.fn() },
  auditMock: { createAuditLog: vi.fn() },
  redisMock: { publish: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/api-auth", () => ({ requireStaff: staffMock.requireStaff }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock.createAuditLog }))
vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/seb-issuance", () => ({ computeSebConfigKey: vi.fn() }))

const EXAM_ID = "c000000000000000000000101"
const OWNER_ID = "teacher-1"

beforeEach(() => {
  vi.clearAllMocks()
  staffMock.requireStaff.mockResolvedValue({ user: { id: OWNER_ID } })
  auditMock.createAuditLog.mockResolvedValue(undefined)
  redisMock.publish.mockResolvedValue(1)
  prismaMock.exam.findUnique.mockResolvedValue({
    id: EXAM_ID,
    creatorId: OWNER_ID,
    status: "PUBLISHED",
    sebRequired: false,
    sebConfigKey: null,
  })
  prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
})

describe("POST /api/exams/[id]/activate question-count race", () => {
  it("refuses activation when the locked exam has no questions", async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { id: EXAM_ID, creatorId: OWNER_ID, status: "PUBLISHED" },
        ]),
      exam: {
        findUnique: vi.fn().mockResolvedValue({
          id: EXAM_ID,
          creatorId: OWNER_ID,
          status: "PUBLISHED",
          sebRequired: false,
          sebConfigKey: null,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn(),
      },
      question: { count: vi.fn().mockResolvedValue(0) },
    }
    prismaMock.$transaction.mockImplementation((callback) => callback(tx))

    const { POST } = await import("@/app/api/exams/[id]/activate/route")
    const response = await POST(
      new NextRequest(`http://localhost/api/exams/${EXAM_ID}/activate`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: EXAM_ID }) }
    )

    expect(response.status).toBe(422)
    expect(tx.$queryRaw).toHaveBeenCalledOnce()
    expect(tx.$queryRaw.mock.calls[0][0].text).toContain("FOR UPDATE")
    expect(tx.question.count).toHaveBeenCalledWith({
      where: { examId: EXAM_ID },
    })
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.question.count.mock.invocationCallOrder[0]
    )
    expect(tx.exam.updateMany).not.toHaveBeenCalled()
    expect(auditMock.createAuditLog).not.toHaveBeenCalled()
    expect(redisMock.publish).not.toHaveBeenCalled()
  })
})
