import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, auditLogMock, rateLimitMock } = vi.hoisted(
  () => ({
    prismaMock: {
      auditLog: { findMany: vi.fn(), create: vi.fn() },
    },
    authMock: { api: { getSession: vi.fn() } },
    auditLogMock: { createAuditLog: vi.fn() },
    rateLimitMock: { rateLimit: vi.fn() },
  })
)

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))
// This route is the only one under test that calls the real rateLimit(),
// which otherwise reaches for the live Redis singleton (lib/redis.ts) —
// unmocked, that stalls each call for several seconds before failing open,
// blowing past vitest's 5000ms per-test timeout.
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rateLimitMock.rateLimit }))

function getRequest(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" })
}

const EXAM_ID = "c000000000000000000000001"

beforeEach(() => {
  vi.clearAllMocks()
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
  rateLimitMock.rateLimit.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetInSeconds: 60,
  })
})

describe("GET /api/audit/export", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { GET } = await import("@/app/api/audit/export/route")
    const res = await GET(getRequest("http://localhost/api/audit/export"))
    expect(res.status).toBe(401)
  })

  it("rejects students", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "s1", role: "STUDENT" },
    })
    const { GET } = await import("@/app/api/audit/export/route")
    const res = await GET(getRequest("http://localhost/api/audit/export"))
    expect(res.status).toBe(403)
  })

  it("scopes teacher exports to their own exams and caps the row count", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "teacher1", role: "TEACHER" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([
      {
        timestamp: new Date("2026-08-14T10:00:00Z"),
        action: "QUESTION_SAVED_TO_BANK",
        ipAddress: "10.0.0.1",
        userAgent: "test-agent",
        metadata: { source: "exam" },
        user: { name: "Lea", email: "lea@schule.ch" },
        exam: { title: "Mathe" },
      },
    ])

    const { GET } = await import("@/app/api/audit/export/route")
    const res = await GET(getRequest("http://localhost/api/audit/export"))

    expect(res.status).toBe(200)
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          exam: { creatorId: "teacher1" },
          examId: { not: null },
        }),
        take: 50000,
      })
    )
    // res.text() drops a BOM while decoding, so check the raw bytes.
    const bytes = new Uint8Array(await res.clone().arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const body = await res.text()
    const lines = body.split("\n")
    expect(lines[0]).toBe(
      "Zeitpunkt,Aktion,Prüfung,Ausgeführt von,E-Mail,IP-Adresse,User-Agent,Details"
    )
    expect(lines[1]).toContain("Frage in Fragenbank gespeichert")
    expect(lines[1]).toContain("Mathe")
    expect(lines[1]).toContain("10.0.0.1")
  })

  it("gives admins unfiltered access to every row", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "admin1", role: "ADMIN" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([])

    const { GET } = await import("@/app/api/audit/export/route")
    await GET(
      getRequest(
        "http://localhost/api/audit/export?action=USER_ROLE_CHANGED&scope=admin"
      )
    )

    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "USER_ROLE_CHANGED" },
      })
    )
  })

  it("scopes an admin's export from the teacher page to their own exams", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "admin1", role: "ADMIN" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([])

    const { GET } = await import("@/app/api/audit/export/route")
    await GET(getRequest("http://localhost/api/audit/export"))

    const callWhere = prismaMock.auditLog.findMany.mock.calls[0][0].where
    expect(callWhere.exam).toEqual({ creatorId: "admin1" })
  })

  it("ignores scope=admin from a teacher", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "teacher1", role: "TEACHER" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([])

    const { GET } = await import("@/app/api/audit/export/route")
    await GET(getRequest("http://localhost/api/audit/export?scope=admin"))

    const callWhere = prismaMock.auditLog.findMany.mock.calls[0][0].where
    expect(callWhere.exam).toEqual({ creatorId: "teacher1" })
  })

  it("passes through the page's filters", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "teacher1", role: "TEACHER" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([])

    const { GET } = await import("@/app/api/audit/export/route")
    await GET(
      getRequest(
        `http://localhost/api/audit/export?examId=${EXAM_ID}&action=EXAM_PUBLISHED&from=2026-01-01&userId=user9&ip=10.0.0`
      )
    )

    const callWhere = prismaMock.auditLog.findMany.mock.calls[0][0].where
    expect(callWhere.examId).toBe(EXAM_ID)
    expect(callWhere.action).toBe("EXAM_PUBLISHED")
    expect(callWhere.userId).toBe("user9")
    expect(callWhere.ipAddress).toEqual({
      contains: "10.0.0",
      mode: "insensitive",
    })
    expect(callWhere.timestamp).toMatchObject({
      gte: new Date("2025-12-31T23:00:00Z"),
    })
  })

  it("escapes CSV fields containing quotes, commas, and newlines", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "admin1", role: "ADMIN" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([
      {
        timestamp: new Date("2026-08-14T10:00:00Z"),
        action: "EXAM_UPDATED",
        ipAddress: null,
        userAgent: null,
        metadata: { note: 'says "hi", then\nnewline' },
        user: { name: "Lea, Müller", email: "lea@schule.ch" },
        exam: null,
      },
    ])

    const { GET } = await import("@/app/api/audit/export/route")
    const res = await GET(getRequest("http://localhost/api/audit/export"))
    const body = await res.text()
    // Commas force the field to be quoted; quotes inside JSON metadata get
    // doubled per RFC 4180. JSON.stringify escapes embedded quotes as \", so
    // the metadata cell carries literal backslash-quotes — still valid CSV.
    expect(body).toContain('"Lea, Müller"')
    expect(body).toContain('"{""note"":""says \\""hi\\"", then\\nnewline""}"')
  })

  it("audit-logs the export itself with scope and row count", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "admin1", role: "ADMIN" },
    })
    prismaMock.auditLog.findMany.mockResolvedValue([])

    const { GET } = await import("@/app/api/audit/export/route")
    await GET(getRequest("http://localhost/api/audit/export?scope=admin"))

    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUDIT_LOG_EXPORTED",
        entityId: "export",
        userId: "admin1",
        metadata: expect.objectContaining({ scope: "admin", rowCount: 0 }),
      })
    )
  })
})
