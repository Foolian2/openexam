import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, rateLimitMock, auditMock, decryptMock } =
  vi.hoisted(() => ({
    prismaMock: { exam: { findUnique: vi.fn() } },
    authMock: { api: { getSession: vi.fn() } },
    rateLimitMock: vi.fn(),
    auditMock: vi.fn(),
    decryptMock: vi.fn(),
  }))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rateLimitMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }))
vi.mock("@/lib/at-rest-encryption", () => ({ decryptSecret: decryptMock }))

import { GET } from "@/app/api/exams/[id]/seb-quit-password/route"

const EXAM_ID = "exam1"

function get() {
  return GET(
    new NextRequest(`https://localhost/api/exams/${EXAM_ID}/seb-quit-password`),
    { params: Promise.resolve({ id: EXAM_ID }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  rateLimitMock.mockResolvedValue({ allowed: true })
  prismaMock.exam.findUnique.mockResolvedValue({
    creatorId: "teacher1",
    sebQuitPassword: "enc:v1:ciphertext",
  })
  decryptMock.mockReturnValue("geheim-123")
})

function expectNotRevealed() {
  expect(decryptMock).not.toHaveBeenCalled()
  expect(auditMock).not.toHaveBeenCalled()
}

describe("GET /api/exams/[id]/seb-quit-password", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expectNotRevealed()
  })

  it("refuses students", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", role: "STUDENT" },
    })
    expect((await get()).status).toBe(403)
    expectNotRevealed()
  })

  it("rate-limits per teacher and fails closed", async () => {
    await get()
    expect(rateLimitMock).toHaveBeenCalledWith(
      "seb-quit-password:teacher1",
      10,
      60,
      "closed"
    )
  })

  it("answers 429 once the budget is used up", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, resetInSeconds: 42 })
    expect((await get()).status).toBe(429)
    expect(prismaMock.exam.findUnique).not.toHaveBeenCalled()
    expectNotRevealed()
  })

  it("hides another teacher's exam as 404", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      creatorId: "teacher2",
      sebQuitPassword: "enc:v1:ciphertext",
    })
    expect((await get()).status).toBe(404)
    expectNotRevealed()
  })

  it("answers 404 when no password is set", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      creatorId: "teacher1",
      sebQuitPassword: null,
    })
    expect((await get()).status).toBe(404)
    expectNotRevealed()
  })

  it("reveals the decrypted password to the owner and audits it", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ password: "geheim-123" })
    expect(decryptMock).toHaveBeenCalledWith("enc:v1:ciphertext")
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SEB_QUIT_PASSWORD_REVEALED",
        entityId: EXAM_ID,
        examId: EXAM_ID,
        userId: "teacher1",
      })
    )
  })
})
