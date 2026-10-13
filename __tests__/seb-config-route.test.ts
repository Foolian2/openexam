import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const {
  prismaMock,
  apiAuthMock,
  rateLimitMock,
  sebLaunchTokenMock,
  sebSecretsMock,
  auditLogMock,
} = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn(), updateMany: vi.fn() },
    examSession: { findUnique: vi.fn() },
  },
  apiAuthMock: { requireSession: vi.fn() },
  rateLimitMock: { rateLimit: vi.fn() },
  sebLaunchTokenMock: { consumeLaunchToken: vi.fn() },
  sebSecretsMock: {
    ensureSebQuitPassword: vi.fn(),
    ensureSebExamKeySalt: vi.fn(),
  },
  auditLogMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/api-auth", () => ({ requireSession: apiAuthMock.requireSession }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rateLimitMock.rateLimit }))
vi.mock("@/lib/seb-launch-token", () => ({
  consumeLaunchToken: sebLaunchTokenMock.consumeLaunchToken,
  peekLaunchToken: vi.fn(),
}))
vi.mock("@/lib/seb-secrets", () => ({
  ensureSebQuitPassword: sebSecretsMock.ensureSebQuitPassword,
  ensureSebExamKeySalt: sebSecretsMock.ensureSebExamKeySalt,
}))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))

const EXAM_ID = "c000000000000000000000001"
const USER_ID = "c000000000000000000000002"
const CREATOR_ID = "c000000000000000000000003"

beforeEach(() => {
  vi.clearAllMocks()
  rateLimitMock.rateLimit.mockResolvedValue({
    allowed: true,
    resetInSeconds: 60,
  })
  apiAuthMock.requireSession.mockResolvedValue({ user: { id: USER_ID } })
  sebSecretsMock.ensureSebQuitPassword.mockResolvedValue("TESTQUITPASS1234")
  sebSecretsMock.ensureSebExamKeySalt.mockResolvedValue(Buffer.alloc(32, 1))
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
  prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
})

describe("GET /api/exams/[id]/seb-config", () => {
  it("rejects unauthenticated requests without launch token", async () => {
    apiAuthMock.requireSession.mockResolvedValue(
      new NextResponse(null, { status: 401 })
    )
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(401)
  })

  it("rejects invalid or expired launch tokens", async () => {
    sebLaunchTokenMock.consumeLaunchToken.mockResolvedValue(null)
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config?lt=invalid-token`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(401)
  })

  it("returns 404 when exam does not exist or sebRequired is false", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(null)
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(404)

    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      sebRequired: false,
      creatorId: CREATOR_ID,
    })
    const res2 = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res2.status).toBe(404)
  })

  it("refuses student download when exam is not ACTIVE", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      status: "DRAFT",
      sebRequired: true,
      creatorId: CREATOR_ID,
    })
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(404)
  })

  it("refuses student download when student has no open session", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      status: "ACTIVE",
      sebRequired: true,
      creatorId: CREATOR_ID,
    })
    prismaMock.examSession.findUnique.mockResolvedValue(null)
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(404)
  })

  it("allows student download when exam is ACTIVE and session is OPEN, and creates audit log", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      status: "ACTIVE",
      sebRequired: true,
      creatorId: CREATOR_ID,
      allowSpellCheck: false,
    })
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: "sess1",
      status: "IN_PROGRESS",
    })
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/seb")
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SEB_CONFIG_DOWNLOADED",
        entityType: "Exam",
        entityId: EXAM_ID,
        examId: EXAM_ID,
        userId: USER_ID,
      })
    )
  })

  it("refuses a configuration whose stored key predates the hardened profile", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      status: "DRAFT",
      sebRequired: true,
      sebConfigKey: "old-unhardened-config-key",
      creatorId: USER_ID,
      allowSpellCheck: false,
    })

    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })

    expect(res.status).toBe(409)
  })

  it("allows creator download even when exam is in DRAFT status (preview)", async () => {
    apiAuthMock.requireSession.mockResolvedValue({ user: { id: CREATOR_ID } })
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      status: "DRAFT",
      sebRequired: true,
      creatorId: CREATOR_ID,
      allowSpellCheck: false,
    })
    const { GET } = await import("@/app/api/exams/[id]/seb-config/route")
    const req = new NextRequest(
      `http://localhost:3000/api/exams/${EXAM_ID}/seb-config`
    )
    const res = await GET(req, { params: Promise.resolve({ id: EXAM_ID }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/seb")
  })
})
