import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth", () => ({ auth: { api: { signUpEmail: vi.fn() } } }))
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() } },
}))
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }))
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}))
vi.mock("@/lib/csrf", () => ({ verifyOrigin: () => null }))

import { POST } from "@/app/api/teacher/register/route"

const fetchMock = vi.fn()

function register(captchaToken: string) {
  return POST(
    new NextRequest("http://localhost/api/teacher/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Anna",
        email: "anna@schule.ch",
        password: "password123",
        accessCode: "wrong-code",
        captchaToken,
        acceptPrivacy: true,
      }),
    })
  )
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("TEACHER_ACCESS_CODE", "right-code")
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fetchMock.mockReset()
})

describe("POST /api/teacher/register captcha", () => {
  it("accepts an empty token when captcha is disabled in dev", async () => {
    // The Cap widget renders nothing with DISABLE_CAPTCHA, so the form
    // sends "". The request must get past validation and the captcha step
    // (here it stops at the wrong access code instead).
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("DISABLE_CAPTCHA", "true")
    const res = await register("")
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("FORBIDDEN")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects an empty token without asking Cap when captcha is required", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("DISABLE_CAPTCHA", "true")
    const res = await register("")
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("CAPTCHA_INVALID")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("still verifies a non-empty token against Cap", async () => {
    vi.stubEnv("NODE_ENV", "production")
    fetchMock.mockResolvedValue(Response.json({ success: false }))
    const res = await register("tok")
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe("CAPTCHA_INVALID")
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
