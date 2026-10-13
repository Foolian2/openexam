import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// requireStaff rejects before any DB access, so prisma can be a bare stub.
const { prismaMock, authMock } = vi.hoisted(() => ({
  prismaMock: {
    questionBankItem: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
  },
  authMock: { api: { getSession: vi.fn() } },
}))
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }))

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/question-bank", {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // A STUDENT session — the bank is staff-only.
  authMock.api.getSession.mockResolvedValue({
    user: { id: "student1", role: "STUDENT" },
  })
})

describe("question-bank is staff-only (students get 403, no solution leak)", () => {
  it("GET /api/question-bank (list) rejects a student", async () => {
    const { GET } = await import("@/app/api/question-bank/route")
    expect((await GET(req("GET"))).status).toBe(403)
  })

  it("POST /api/question-bank (create) rejects a student", async () => {
    const { POST } = await import("@/app/api/question-bank/route")
    const res = await POST(req("POST", { type: "SHORT_ANSWER", title: "x", points: 1, required: true, config: { acceptedAnswers: ["a"], caseSensitive: false, maxLength: 10 } }))
    expect(res.status).toBe(403)
    expect(prismaMock.questionBankItem.create).not.toHaveBeenCalled()
  })

  it("POST /api/question-bank (create) refuses a request without Origin before auth", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "teacher1", role: "TEACHER" },
    })
    const { POST } = await import("@/app/api/question-bank/route")
    const res = await POST(
      new NextRequest("http://localhost/api/question-bank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      })
    )
    expect(res.status).toBe(403)
    expect(authMock.api.getSession).not.toHaveBeenCalled()
    expect(prismaMock.questionBankItem.create).not.toHaveBeenCalled()
  })

  it("GET /api/question-bank/shared/[token] does not return solutions to a student", async () => {
    const { GET } = await import("@/app/api/question-bank/shared/[token]/route")
    const res = await GET(
      new NextRequest("http://localhost/api/question-bank/shared/tok", {
        headers: { origin: "http://localhost:3000" },
      }),
      { params: Promise.resolve({ token: "tok" }) }
    )
    expect(res.status).toBe(403)
    // The handler must bail before loading the item's config.
    expect(prismaMock.questionBankItem.findUnique).not.toHaveBeenCalled()
  })

  it("GET /api/question-bank/export rejects a student", async () => {
    const { GET } = await import("@/app/api/question-bank/export/route")
    expect((await GET(req("GET"))).status).toBe(403)
  })
})
