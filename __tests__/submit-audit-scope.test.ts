import { expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const m = vi.hoisted(() => ({
  find: vi.fn(),
  transaction: vi.fn(),
  auth: vi.fn(),
  finalize: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { examSession: { findUnique: m.find }, $transaction: m.transaction },
}))
vi.mock("@/lib/api-auth", () => ({ requireSession: m.auth }))
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}))
vi.mock("@/lib/seb-guard", () => ({
  verifySebAccess: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock("@/lib/finalize-session", () => ({ finalizeSession: m.finalize }))
it("scopes submission audit events to the exam so its teacher can see them", async () => {
  const row = {
    id: "session",
    userId: "student",
    examId: "exam",
    status: "IN_PROGRESS",
    effectiveEndTime: new Date(Date.now() + 60000),
    exam: {},
  }
  m.auth.mockResolvedValue({ user: { id: "student" } })
  m.find.mockResolvedValue(row)
  m.transaction.mockImplementation(async (cb) =>
    cb({
      examSession: {
        findUnique: vi.fn().mockResolvedValue(row),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    })
  )
  const { POST } = await import("@/app/api/sessions/[id]/submit/route")
  const response = await POST(
    new NextRequest("http://localhost/api/sessions/session/submit", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "submission-audit-key" }),
    }),
    { params: Promise.resolve({ id: "session" }) }
  )
  expect(response.status).toBe(200)
  expect(m.finalize).toHaveBeenCalledWith(
    expect.objectContaining({
      audit: expect.objectContaining({
        examId: "exam",
        action: "SESSION_SUBMITTED",
      }),
    })
  )
})
