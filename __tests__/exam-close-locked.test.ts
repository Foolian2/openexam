import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, finalizeMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn() },
    examSession: { updateMany: vi.fn() },
    auditLog: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  authMock: { api: { getSession: vi.fn() } },
  finalizeMock: { finalizeSession: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/finalize-session", () => ({
  finalizeSession: finalizeMock.finalizeSession,
}))

const ID = "c000000000000000000000010"

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "t1", role: "TEACHER" },
  })
  finalizeMock.finalizeSession.mockResolvedValue(undefined)
  prismaMock.examSession.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.exam.findUnique.mockResolvedValue({
    id: ID,
    creatorId: "t1",
    status: "ACTIVE",
  })
})

describe("POST /api/exams/[id]/close force-submits LOCKED sessions too", () => {
  it("selects IN_PROGRESS and LOCKED and finalizes them (no orphaned LOCKED)", async () => {
    const txExam = {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: ID, status: "CLOSED" }),
    }
    const claimSessions = vi
      .fn()
      .mockResolvedValue([{ id: "s-inprogress" }, { id: "s-locked" }])
    prismaMock.$transaction.mockImplementation(async (fn) =>
      fn({
        exam: txExam,
        auditLog: prismaMock.auditLog,
        $queryRaw: claimSessions,
      })
    )

    const { POST } = await import("@/app/api/exams/[id]/close/route")
    const req = new NextRequest(`http://localhost/api/exams/${ID}/close`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    })
    const res = await POST(req, { params: Promise.resolve({ id: ID }) })
    expect(res.status).toBe(200)

    // The atomic UPDATE ... RETURNING claims both active and locked rows;
    // only returned rows are handed to finalization.
    expect(claimSessions).toHaveBeenCalledOnce()
    const claimQuery = claimSessions.mock.calls[0][0]
    expect(claimQuery.text).toContain('RETURNING "id"')
    expect(claimQuery.values).toEqual(
      expect.arrayContaining(["IN_PROGRESS", "LOCKED"])
    )
    expect(finalizeMock.finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIds: ["s-inprogress", "s-locked"] })
    )
  })

  it("sets the durable retry marker in the claim and clears it only after finalization", async () => {
    const order: string[] = []
    const claimSessions = vi.fn().mockResolvedValue([{ id: "s1" }])
    prismaMock.$transaction.mockImplementation(async (fn) =>
      fn({
        exam: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: ID }),
        },
        auditLog: prismaMock.auditLog,
        $queryRaw: claimSessions,
      })
    )
    finalizeMock.finalizeSession.mockImplementation(async () => {
      order.push("finalize")
    })
    prismaMock.examSession.updateMany.mockImplementation(async () => {
      order.push("clear")
      return { count: 1 }
    })

    const { POST } = await import("@/app/api/exams/[id]/close/route")
    const req = new NextRequest(`http://localhost/api/exams/${ID}/close`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    })
    const res = await POST(req, { params: Promise.resolve({ id: ID }) })
    expect(res.status).toBe(200)

    expect(claimSessions.mock.calls[0][0].text).toContain(
      '"deadlineFinalizationPending" = true'
    )
    expect(order).toEqual(["finalize", "clear"])
    expect(prismaMock.examSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s1"] }, deadlineFinalizationPending: true },
      data: { deadlineFinalizationPending: false },
    })
  })

  it("leaves the marker set when finalization throws so the sweeper retries", async () => {
    prismaMock.$transaction.mockImplementation(async (fn) =>
      fn({
        exam: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: ID }),
        },
        auditLog: prismaMock.auditLog,
        $queryRaw: vi.fn().mockResolvedValue([{ id: "s1" }]),
      })
    )
    finalizeMock.finalizeSession.mockRejectedValue(new Error("crash"))

    const { POST } = await import("@/app/api/exams/[id]/close/route")
    const req = new NextRequest(`http://localhost/api/exams/${ID}/close`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    })
    await expect(
      POST(req, { params: Promise.resolve({ id: ID }) })
    ).rejects.toThrow("crash")
    expect(prismaMock.examSession.updateMany).not.toHaveBeenCalled()
    // Even if post-commit work crashes, the original close event is durable;
    // the sweeper only reconstructs the individual session submissions.
    expect(prismaMock.auditLog.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          action: "EXAM_CLOSED",
          examId: ID,
          userId: "t1",
          metadata: { forcedSubmissions: 1 },
          idempotencyKey: `EXAM_CLOSED:${ID}`,
        }),
      ],
      skipDuplicates: true,
    })
  })

  it("does not finalize when the close audit cannot commit", async () => {
    prismaMock.$transaction.mockImplementation(async (fn) =>
      fn({
        exam: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({ id: ID }),
        },
        auditLog: {
          createMany: vi.fn().mockRejectedValue(new Error("audit unavailable")),
        },
        $queryRaw: vi.fn().mockResolvedValue([{ id: "s1" }]),
      })
    )
    const { POST } = await import("@/app/api/exams/[id]/close/route")
    const req = new NextRequest(`http://localhost/api/exams/${ID}/close`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    })
    await expect(
      POST(req, { params: Promise.resolve({ id: ID }) })
    ).rejects.toThrow("audit unavailable")
    expect(finalizeMock.finalizeSession).not.toHaveBeenCalled()
    expect(prismaMock.examSession.updateMany).not.toHaveBeenCalled()
  })
})
