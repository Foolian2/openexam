import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, txMock, committedMock, authMock, redisMock, auditMock } =
  vi.hoisted(() => {
    const txMock = {
      $queryRaw: vi.fn(),
      user: { update: vi.fn() },
      session: { findMany: vi.fn(), deleteMany: vi.fn() },
    }
    // Called once the transaction callback has resolved, i.e. at commit,
    // so tests can order other calls against the commit itself.
    const committedMock = vi.fn()
    return {
      txMock,
      committedMock,
      prismaMock: {
        user: { findUnique: vi.fn() },
        $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) => {
          const result = await fn(txMock)
          committedMock()
          return result
        }),
      },
      authMock: { api: { getSession: vi.fn() } },
      redisMock: { del: vi.fn() },
      auditMock: vi.fn(),
    }
  })

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
// The real lib/session-revocation runs on top of this, so the route and the
// purge are exercised together.
vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }))

import { PATCH } from "@/app/api/admin/users/[userId]/route"

const TARGET_ID = "target1"

function patch(body: unknown, userId = TARGET_ID) {
  return PATCH(
    new NextRequest(`https://localhost/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) }
  )
}

function targetIs(role: string) {
  prismaMock.user.findUnique.mockResolvedValue({ id: TARGET_ID, role })
  txMock.user.update.mockImplementation(async ({ data }) => ({
    id: TARGET_ID,
    name: "Target",
    email: "target@stud.example-school.ch",
    role: data.role,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "admin1", role: "ADMIN" },
  })
  targetIs("STUDENT")
  txMock.session.findMany.mockResolvedValue([
    { token: "tok-a" },
    { token: "tok-b" },
  ])
  txMock.session.deleteMany.mockResolvedValue({ count: 2 })
  redisMock.del.mockResolvedValue(1)
})

describe("PATCH /api/admin/users/[userId]: access", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    expect((await patch({ role: "TEACHER" })).status).toBe(401)
  })

  it.each(["STUDENT", "TEACHER"])("refuses a %s", async (role) => {
    authMock.api.getSession.mockResolvedValue({ user: { id: "u1", role } })
    expect((await patch({ role: "ADMIN" })).status).toBe(403)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it("refuses to change the caller's own role", async () => {
    expect((await patch({ role: "STUDENT" }, "admin1")).status).toBe(403)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it("rejects an unknown role", async () => {
    expect((await patch({ role: "SUPERUSER" })).status).toBe(422)
  })

  it("answers 404 for an unknown user", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null)
    expect((await patch({ role: "TEACHER" })).status).toBe(404)
  })
})

describe("PATCH /api/admin/users/[userId]: role change", () => {
  it("leaves an unchanged role alone, sessions included", async () => {
    targetIs("TEACHER")
    const res = await patch({ role: "TEACHER" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: TARGET_ID, role: "TEACHER" },
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(redisMock.del).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })

  it("revokes the target's sessions in the same transaction as the role change", async () => {
    const res = await patch({ role: "TEACHER" })
    expect(res.status).toBe(200)
    expect((await res.json()).user.role).toBe("TEACHER")

    expect(txMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_ID },
        data: { role: "TEACHER" },
      })
    )
    expect(txMock.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: TARGET_ID },
    })
  })

  it("purges the revoked sessions' Redis snapshots after the commit", async () => {
    await patch({ role: "TEACHER" })
    expect(redisMock.del).toHaveBeenCalledWith("tok-a")
    expect(redisMock.del).toHaveBeenCalledWith("tok-b")
    // Purging inside the transaction would drop the snapshots of sessions
    // whose rows survive if the commit then fails.
    expect(committedMock).toHaveBeenCalledTimes(1)
    const commitOrder = committedMock.mock.invocationCallOrder[0]
    for (const order of redisMock.del.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(commitOrder)
    }
  })

  it("writes the audit entry with the old and new role", async () => {
    await patch({ role: "TEACHER" })
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_ROLE_CHANGED",
        entityType: "User",
        entityId: TARGET_ID,
        userId: "admin1",
        metadata: { from: "STUDENT", to: "TEACHER" },
      })
    )
  })

  it("doesn't take the admin lock when nobody is demoted from ADMIN", async () => {
    await patch({ role: "ADMIN" })
    expect(txMock.$queryRaw).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/admin/users/[userId]: last admin", () => {
  beforeEach(() => {
    targetIs("ADMIN")
  })

  it("refuses to demote the last admin and revokes nothing", async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: TARGET_ID }])

    const res = await patch({ role: "TEACHER" })
    expect(res.status).toBe(409)
    expect(txMock.user.update).not.toHaveBeenCalled()
    expect(txMock.session.deleteMany).not.toHaveBeenCalled()
    expect(redisMock.del).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })

  it("counts the admins under a row lock", async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: TARGET_ID }, { id: "admin1" }])

    await patch({ role: "TEACHER" })
    // Tagged template: the first argument holds the SQL text. Without
    // FOR UPDATE, two concurrent demotions could each count two admins and
    // leave none.
    const [strings] = txMock.$queryRaw.mock.calls[0]
    expect(strings.join("?")).toMatch(
      /SELECT id FROM "User" WHERE role = 'ADMIN' FOR UPDATE/
    )
  })

  it("demotes an admin when another one remains", async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: TARGET_ID }, { id: "admin1" }])

    const res = await patch({ role: "TEACHER" })
    expect(res.status).toBe(200)
    expect(txMock.session.deleteMany).toHaveBeenCalled()
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { from: "ADMIN", to: "TEACHER" } })
    )
  })
})
