import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  exam: { findUnique: vi.fn() },
  session: { findUnique: vi.fn() },
  transaction: vi.fn(),
  auth: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { exam: m.exam, examSession: m.session, $transaction: m.transaction },
}))
vi.mock("@/lib/api-auth", () => ({ requireStudent: m.auth }))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.limit }))
vi.mock("@/lib/exam-admission", () => ({ reserveAdmission: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: "student" } })
  m.limit.mockResolvedValue({ allowed: true })
  m.exam.findUnique.mockResolvedValue({
    id: "exam",
    status: "ACTIVE",
    title: "x",
    timeLimitMin: 60,
    scheduledEnd: new Date("2030-01-01T10:10:00Z"),
    scheduledStart: null,
  })
})
it("rejoining preserves an already extended deadline, including concurrent extension", async () => {
  const original = {
    id: "session",
    status: "IN_PROGRESS",
    startedAt: new Date("2030-01-01T10:00:00Z"),
    effectiveEndTime: new Date("2030-01-01T10:40:00Z"),
    timeExtensionMin: 30,
  }
  m.session.findUnique.mockResolvedValue(original)
  const settled = {
    ...original,
    effectiveEndTime: new Date("2030-01-01T10:50:00Z"),
    timeExtensionMin: 40,
  }
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  m.transaction.mockImplementation(async (cb) =>
    cb({
      examSession: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue(settled),
      },
    })
  )
  const { POST } = await import("@/app/api/sessions/route")
  const res = await POST(
    new NextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      body: JSON.stringify({ accessCode: "ABCDEF" }),
    })
  )
  expect(res.status).toBe(200)
  expect(updateMany.mock.calls[0][0].data).not.toHaveProperty(
    "effectiveEndTime"
  )
})

it("refuses to join without a strict same-site Origin (CSRF)", async () => {
  const { POST } = await import("@/app/api/sessions/route")
  const res = await POST(
    new NextRequest("http://localhost/api/sessions", {
      method: "POST",
      body: JSON.stringify({ accessCode: "ABCDEF" }),
    })
  )
  expect(res.status).toBe(403)
})
