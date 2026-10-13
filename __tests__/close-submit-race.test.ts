import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, finalizeMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn() },
    examSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  authMock: { requireStaff: vi.fn() },
  finalizeMock: { finalizeSession: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/api-auth", () => ({ requireStaff: authMock.requireStaff }))
vi.mock("@/lib/finalize-session", () => ({
  finalizeSession: finalizeMock.finalizeSession,
}))

const examId = "c000000000000000000000010"

beforeEach(() => {
  vi.clearAllMocks()
  authMock.requireStaff.mockResolvedValue({ user: { id: "teacher-1" } })
  prismaMock.exam.findUnique.mockResolvedValue({
    id: examId,
    creatorId: "teacher-1",
    status: "ACTIVE",
  })
  finalizeMock.finalizeSession.mockResolvedValue(undefined)
})

describe("POST /api/exams/[id]/close submission race", () => {
  it("finalizes only sessions returned by the guarded AUTO_SUBMITTED update", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const findUniqueOrThrow = vi.fn().mockResolvedValue({
      id: examId,
      status: "CLOSED",
    })
    const queryRaw = vi.fn().mockResolvedValue([{ id: "close-won" }])
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        exam: { updateMany, findUniqueOrThrow },
        auditLog: prismaMock.auditLog,
        $queryRaw: queryRaw,
      })
    )

    const { POST } = await import("@/app/api/exams/[id]/close/route")
    const request = new NextRequest(
      `http://localhost/api/exams/${examId}/close`,
      { method: "POST", headers: { origin: "http://localhost:3000" } }
    )
    const response = await POST(request, {
      params: Promise.resolve({ id: examId }),
    })

    expect(response.status).toBe(200)
    expect(queryRaw).toHaveBeenCalledOnce()
    const query = queryRaw.mock.calls[0][0]
    const sql = query.text as string
    expect(query.values).toEqual(
      expect.arrayContaining([examId, "IN_PROGRESS", "LOCKED"])
    )
    expect(sql).toContain('"status"::text IN')
    expect(sql).toContain('RETURNING "id"')
    expect(finalizeMock.finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ["close-won"] })
    )
    expect(await response.json()).toMatchObject({ forcedSubmissions: 1 })
  })

  it("does not finalize sessions already won by submit or the deadline sweeper", async () => {
    const queryRaw = vi.fn().mockResolvedValue([])
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({
        exam: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: examId,
            status: "CLOSED",
          }),
        },
        auditLog: prismaMock.auditLog,
        $queryRaw: queryRaw,
      })
    )

    const { POST } = await import("@/app/api/exams/[id]/close/route")
    const request = new NextRequest(
      `http://localhost/api/exams/${examId}/close`,
      { method: "POST", headers: { origin: "http://localhost:3000" } }
    )
    const response = await POST(request, {
      params: Promise.resolve({ id: examId }),
    })

    expect(response.status).toBe(200)
    expect(finalizeMock.finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: [] })
    )
    expect(await response.json()).toMatchObject({ forcedSubmissions: 0 })
    expect(prismaMock.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: "EXAM_CLOSED",
          examId,
          metadata: { forcedSubmissions: 0 },
        }),
      ],
      skipDuplicates: true,
    })
  })
})
