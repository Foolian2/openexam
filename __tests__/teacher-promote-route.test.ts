import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, auditLogMock, rateLimitMock, revokeMock } =
  vi.hoisted(() => ({
    prismaMock: {
      user: { update: vi.fn(), updateMany: vi.fn() },
      $transaction: vi.fn(),
    },
    authMock: { api: { getSession: vi.fn(), signInEmail: vi.fn() } },
    auditLogMock: { createAuditLog: vi.fn() },
    rateLimitMock: { rateLimit: vi.fn() },
    revokeMock: {
      revokeUserSessionsInTx: vi.fn(),
      purgeSessionRedisKeys: vi.fn(),
    },
  }))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rateLimitMock.rateLimit }))
vi.mock("@/lib/session-revocation", () => ({
  revokeUserSessionsInTx: revokeMock.revokeUserSessionsInTx,
  purgeSessionRedisKeys: revokeMock.purgeSessionRedisKeys,
}))

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/teacher/promote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TEACHER_ACCESS_CODE = "dev-teacher-code"
  rateLimitMock.rateLimit.mockResolvedValue({
    allowed: true,
    resetInSeconds: 0,
  })
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
  revokeMock.revokeUserSessionsInTx.mockResolvedValue(["tok1"])
  revokeMock.purgeSessionRedisKeys.mockResolvedValue(undefined)
  prismaMock.user.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.$transaction.mockImplementation(async (fn) =>
    fn({
      user: { updateMany: prismaMock.user.updateMany },
    })
  )
})

describe("POST /api/teacher/promote role guard", () => {
  it("rejects an ADMIN caller and never changes a role (no self-demotion)", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "admin1", email: "a@x.test", role: "ADMIN" },
    })
    const { POST } = await import("@/app/api/teacher/promote/route")
    const res = await POST(req({ accessCode: "dev-teacher-code" }))
    expect(res.status).toBe(403)
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.user.update).not.toHaveBeenCalled()
  })

  it("rejects a TEACHER caller (already staff, nothing to promote)", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "teacher1", email: "t@x.test", role: "TEACHER" },
    })
    const { POST } = await import("@/app/api/teacher/promote/route")
    const res = await POST(req({ accessCode: "dev-teacher-code" }))
    expect(res.status).toBe(403)
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled()
  })

  it("promotes a STUDENT with the correct code (scoped to role=STUDENT)", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", email: "s@x.test", role: "STUDENT" },
    })
    const { POST } = await import("@/app/api/teacher/promote/route")
    const res = await POST(req({ accessCode: "dev-teacher-code" }))
    expect(res.status).toBe(200)
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "student1", role: "STUDENT" },
        data: { role: "TEACHER" },
      })
    )
  })

  it("rejects a STUDENT with a wrong code", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student2", email: "s2@x.test", role: "STUDENT" },
    })
    const { POST } = await import("@/app/api/teacher/promote/route")
    const res = await POST(req({ accessCode: "wrong" }))
    expect(res.status).toBe(403)
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled()
  })

  it("answers 409 and audits a no-op when a concurrent role change wins the race", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", email: "s@x.test", role: "STUDENT" },
    })
    prismaMock.user.updateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import("@/app/api/teacher/promote/route")
    const res = await POST(
      req({ accessCode: "dev-teacher-code", email: "s@x.test", password: "pw" })
    )
    expect(res.status).toBe(409)
    expect(revokeMock.revokeUserSessionsInTx).not.toHaveBeenCalled()
    expect(revokeMock.purgeSessionRedisKeys).not.toHaveBeenCalled()
    expect(authMock.api.signInEmail).not.toHaveBeenCalled()
    const actions = auditLogMock.createAuditLog.mock.calls.map(
      ([arg]) => (arg as { action: string }).action
    )
    expect(actions).toEqual(["TEACHER_PROMOTE_NOOP"])
  })
})
