import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  createInterval: vi.fn(),
  endInterval: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  publish: vi.fn(),
}))
vi.mock("@/lib/api-auth", () => ({
  requireStaff: vi.fn(async () => ({
    user: { id: "teacher", role: "TEACHER" },
  })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: { findUnique: mocks.read },
    $transaction: mocks.transaction,
  },
}))
vi.mock("@/lib/redis", () => ({ redis: { publish: mocks.publish } }))
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }))
import { POST } from "@/app/api/sessions/[id]/lock/route"
const params = { params: Promise.resolve({ id: "s1" }) }
function request(locked: boolean) {
  return new NextRequest("https://localhost/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locked }),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue({
    id: "s1",
    exam: { id: "e1", creatorId: "teacher", status: "ACTIVE" },
  })
  mocks.write.mockResolvedValue({ count: 1 })
  mocks.createInterval.mockResolvedValue({})
  mocks.endInterval.mockResolvedValue({ count: 1 })
  mocks.queryRaw
    .mockReset()
    .mockImplementation((parts: TemplateStringsArray) => {
      const sql = parts.join(" ")
      if (sql.includes("clock_timestamp")) {
        return [{ transitionedAt: new Date("2026-10-06T12:00:00.123Z") }]
      }
      if (sql.includes('FROM "Exam"')) return [{ id: "e1" }]
      return [{ id: "s1" }]
    })
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      $queryRaw: mocks.queryRaw,
      examSession: {
        updateMany: mocks.write,
        findUniqueOrThrow: vi.fn(async () => ({ id: "s1", status: "LOCKED" })),
      },
      sessionLockInterval: {
        create: mocks.createInterval,
        updateMany: mocks.endInterval,
      },
    })
  )
})
describe("session lock boundary", () => {
  it("persists the timestamp used by the WS flusher in the lock transition", async () => {
    expect((await POST(request(true), params)).status).toBe(200)
    expect(mocks.queryRaw).toHaveBeenCalledTimes(3)
    const lockQueries = mocks.queryRaw.mock.calls.map(([parts]) => parts.join(" "))
    expect(lockQueries[0]).toContain("FOR SHARE OF e")
    expect(lockQueries[1]).toContain("FOR UPDATE OF es")
    expect(lockQueries[2]).toContain("clock_timestamp()")
    expect(mocks.write).toHaveBeenCalledWith({
      where: {
        id: "s1",
        exam: { status: "ACTIVE" },
        status: { in: ["IN_PROGRESS"] },
      },
      data: { status: "LOCKED", lockedAt: expect.any(Date) },
    })
    expect(mocks.createInterval).toHaveBeenCalledWith({
      data: {
        sessionId: "s1",
        lockedAt: mocks.write.mock.calls[0][0].data.lockedAt,
      },
    })
  })
  it("clears the timestamp on unlock", async () => {
    expect((await POST(request(false), params)).status).toBe(200)
    expect(mocks.write).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "IN_PROGRESS", lockedAt: null },
      })
    )
    expect(mocks.endInterval).toHaveBeenCalledWith({
      where: { sessionId: "s1", unlockedAt: null },
      data: { unlockedAt: new Date("2026-10-06T12:00:00.123Z") },
    })
  })
  it("rolls back an unlock with no open interval", async () => {
    mocks.endInterval.mockResolvedValueOnce({ count: 0 })
    const response = await POST(request(false), params)
    expect(response.status).toBe(409)
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it.each(["CLOSED", "GRADED", "ARCHIVED"])(
    "cannot resurrect a legacy locked session in %s",
    async (status) => {
      mocks.read.mockResolvedValue({
        id: "s1",
        exam: { id: "e1", creatorId: "teacher", status },
      })
      expect((await POST(request(false), params)).status).toBe(409)
      expect(mocks.transaction).not.toHaveBeenCalled()
    }
  )
})
