import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, redisMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    examSession: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
  authMock: { requireStaff: vi.fn() },
  redisMock: { publish: vi.fn() },
  auditMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/api-auth", () => ({ requireStaff: authMock.requireStaff }))
vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock.createAuditLog }))

const sessionId = "c000000000000000000000011"
const effectiveEndTime = new Date("2026-10-06T10:00:00Z")

beforeEach(() => {
  vi.clearAllMocks()
  authMock.requireStaff.mockResolvedValue({ user: { id: "teacher-1" } })
  prismaMock.examSession.findUnique.mockResolvedValue({
    id: sessionId,
    examId: "exam-1",
    userId: "student-1",
    status: "IN_PROGRESS",
    timeExtensionMin: 0,
    effectiveEndTime,
    namApplied: false,
    exam: { creatorId: "teacher-1", timeLimitMin: 60 },
  })
  redisMock.publish.mockResolvedValue(1)
  auditMock.createAuditLog.mockResolvedValue(undefined)
})

function request() {
  return new NextRequest(`http://localhost/api/sessions/${sessionId}/extend`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify({ minutes: 5 }),
  })
}

describe("POST /api/sessions/[id]/extend terminal-state guard", () => {
  it("returns 409 when the sweeper submits after the initial read", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ status: "AUTO_SUBMITTED", namApplied: false }])
    const update = vi.fn()
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({ examSession: { update }, $queryRaw: queryRaw })
    )

    const { POST } = await import("@/app/api/sessions/[id]/extend/route")
    const response = await POST(request(), {
      params: Promise.resolve({ id: sessionId }),
    })

    expect(response.status).toBe(409)
    expect(update).not.toHaveBeenCalled()
    expect(redisMock.publish).not.toHaveBeenCalled()
    expect(auditMock.createAuditLog).not.toHaveBeenCalled()
    expect(queryRaw.mock.calls[0][0].text).toContain("FOR UPDATE")
  })

  it("extends an active row while holding the transaction row lock", async () => {
    const incremented = {
      id: sessionId,
      timeExtensionMin: 5,
      effectiveEndTime: new Date(effectiveEndTime.getTime() + 5 * 60_000),
      namApplied: false,
    }
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ status: "IN_PROGRESS", namApplied: false }])
    const update = vi.fn().mockResolvedValue(incremented)
    prismaMock.$transaction.mockImplementation(async (callback) =>
      callback({ examSession: { update }, $queryRaw: queryRaw })
    )

    const { POST } = await import("@/app/api/sessions/[id]/extend/route")
    const response = await POST(request(), {
      params: Promise.resolve({ id: sessionId }),
    })

    expect(response.status).toBe(200)
    expect(queryRaw.mock.calls[0][0].text).toContain("FOR UPDATE")
    expect(update).toHaveBeenCalledTimes(2)
    expect(redisMock.publish).toHaveBeenCalledOnce()
    expect(auditMock.createAuditLog).toHaveBeenCalledOnce()
  })
})
