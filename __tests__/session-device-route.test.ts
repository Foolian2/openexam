import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  requireSession: vi.fn(),
  findUnique: vi.fn(),
  rateLimit: vi.fn(),
  sebGuard: vi.fn(),
  claim: vi.fn(),
  verifyOrigin: vi.fn(),
}))

vi.mock("@/lib/api-auth", () => ({ requireSession: m.requireSession }))
vi.mock("@/lib/prisma", () => ({
  prisma: { examSession: { findUnique: m.findUnique } },
}))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.rateLimit }))
vi.mock("@/lib/csrf", () => ({ verifyOrigin: m.verifyOrigin }))
vi.mock("@/lib/seb-guard", () => ({ verifySebAccess: m.sebGuard }))
vi.mock("@/lib/seb-urls", () => ({
  publicRequestUrl: () => "https://localhost/device",
}))
vi.mock("@/lib/exam-device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/exam-device")>()),
  claimExamDevice: m.claim,
}))

import { POST } from "@/app/api/sessions/[id]/device/route"

const DEVICE = "11111111-1111-4111-8111-111111111111"
const post = (deviceId: string | null = DEVICE) =>
  POST(
    new NextRequest("https://localhost/api/sessions/sess-1/device", {
      method: "POST",
      headers: {
        "user-agent": "SEB",
        ...(deviceId ? { "x-openexam-device-id": deviceId } : {}),
      },
    }),
    { params: Promise.resolve({ id: "sess-1" }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  m.verifyOrigin.mockReturnValue(null)
  m.requireSession.mockResolvedValue({
    user: { id: "student-1" },
    session: { id: "auth-1" },
  })
  m.rateLimit.mockResolvedValue({ allowed: true })
  m.sebGuard.mockResolvedValue({ ok: true })
  m.findUnique.mockResolvedValue({
    id: "sess-1",
    examId: "exam-1",
    userId: "student-1",
    status: "IN_PROGRESS",
    exam: { id: "exam-1" },
  })
  m.claim.mockResolvedValue({ replaced: false })
})

describe("POST /api/sessions/[id]/device", () => {
  it("claims the session for the caller's login", async () => {
    m.claim.mockResolvedValue({ replaced: true, count: 1 })
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ replaced: true })
    expect(m.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        examSessionId: "sess-1",
        examId: "exam-1",
        userId: "student-1",
        authSessionId: "auth-1",
        deviceId: DEVICE,
        userAgent: "SEB",
      })
    )
  })

  it("hides another student's session as 404", async () => {
    m.findUnique.mockResolvedValue({
      id: "sess-1",
      examId: "exam-1",
      userId: "student-2",
      status: "IN_PROGRESS",
      exam: { id: "exam-1" },
    })
    expect((await post()).status).toBe(404)
    expect(m.claim).not.toHaveBeenCalled()
  })

  it("requires SEB like every other student route", async () => {
    m.sebGuard.mockResolvedValue({ ok: false, reason: "missing_token" })
    expect((await post()).status).toBe(403)
    expect(m.claim).not.toHaveBeenCalled()
  })

  it("refuses a submitted session", async () => {
    m.findUnique.mockResolvedValue({
      id: "sess-1",
      examId: "exam-1",
      userId: "student-1",
      status: "SUBMITTED",
      exam: { id: "exam-1" },
    })
    expect((await post()).status).toBe(409)
    expect(m.claim).not.toHaveBeenCalled()
  })

  it("throttles repeated claims", async () => {
    m.rateLimit.mockResolvedValue({ allowed: false, resetInSeconds: 30 })
    expect((await post()).status).toBe(429)
    expect(m.claim).not.toHaveBeenCalled()
  })

  it("keys the claim budget by exam session", async () => {
    await post()
    expect(m.rateLimit).toHaveBeenCalledWith(
      "session-device:student-1:sess-1",
      20,
      60
    )
  })
})

it("refuses a missing or invalid tab identity", async () => {
  expect((await post(null)).status).toBe(422)
  expect((await post("invalid")).status).toBe(422)
  expect(m.claim).not.toHaveBeenCalled()
})

it("surfaces a lost claim instead of reporting success", async () => {
  const { ApiError } = await import("@/lib/api-response")
  m.claim.mockRejectedValue(new ApiError(409, "SESSION_REPLACED", "Replaced"))
  const res = await post()
  expect(res.status).toBe(409)
  expect((await res.json()).error.code).toBe("SESSION_REPLACED")
})

it("allows a locked session to establish ownership before it is unlocked", async () => {
  m.findUnique.mockResolvedValue({
    id: "sess-1",
    examId: "exam-1",
    userId: "student-1",
    status: "LOCKED",
    exam: { id: "exam-1" },
  })
  expect((await post()).status).toBe(200)
  expect(m.claim).toHaveBeenCalled()
})
