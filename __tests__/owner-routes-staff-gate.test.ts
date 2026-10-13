import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// Regression for AZ1/A1b-3: a user demoted TEACHER→STUDENT (or any STUDENT)
// must be rejected by owner-only teacher routes, which previously used
// requireSession + a creatorId check and so kept serving a demoted creator
// (incl. destructive writes and the plaintext SEB quit password). requireStaff
// rejects before any DB access, so a bare prisma stub suffices.
const { prismaMock, authMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    examSession: { findUnique: vi.fn(), update: vi.fn() },
    folder: { findFirst: vi.fn(), update: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
}))
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }))
vi.mock("@/lib/redis", () => ({ redis: { publish: vi.fn() } }))

const ID = "c000000000000000000000020"
function r(method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/x`, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}
const p = { params: Promise.resolve({ id: ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "exowner", role: "STUDENT" }, // the demoted ex-teacher
  })
})

describe("owner-only teacher routes reject a demoted (STUDENT) caller", () => {
  it("POST /api/exams/[id]/publish → 403", async () => {
    const { POST } = await import("@/app/api/exams/[id]/publish/route")
    expect((await POST(r("POST"), p)).status).toBe(403)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })
  it("POST /api/exams/[id]/close → 403", async () => {
    const { POST } = await import("@/app/api/exams/[id]/close/route")
    expect((await POST(r("POST"), p)).status).toBe(403)
  })
  it("PUT /api/sessions/[id]/grades → 403", async () => {
    const { PUT } = await import("@/app/api/sessions/[id]/grades/route")
    expect((await PUT(r("PUT", { grades: [] }), p)).status).toBe(403)
  })
  it("POST /api/sessions/[id]/lock → 403", async () => {
    const { POST } = await import("@/app/api/sessions/[id]/lock/route")
    expect((await POST(r("POST", { locked: true }), p)).status).toBe(403)
  })
  it("PATCH /api/folders/[id] → 403", async () => {
    const { PATCH } = await import("@/app/api/folders/[id]/route")
    expect((await PATCH(r("PATCH", { name: "x" }), p)).status).toBe(403)
  })
})
