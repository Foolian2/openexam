import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { verifyOrigin } from "@/lib/csrf"

function requestWithOrigin(origin: string | null) {
  const headers = new Headers()
  if (origin) headers.set("origin", origin)
  return new NextRequest("http://localhost:3000/api/teacher/auto-archive", {
    method: "PATCH",
    headers,
  })
}

describe("verifyOrigin", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS
    delete process.env.NEXT_PUBLIC_BASE_URL
    delete process.env.BETTER_AUTH_URL
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("rejects requests with no Origin header", () => {
    const result = verifyOrigin(requestWithOrigin(null))
    expect(result?.status).toBe(403)
  })

  it("rejects an Origin not in ALLOWED_ORIGINS", () => {
    process.env.ALLOWED_ORIGINS = "https://exam.example.com"
    const result = verifyOrigin(requestWithOrigin("https://evil.example.com"))
    expect(result?.status).toBe(403)
  })

  it("allows an Origin listed in ALLOWED_ORIGINS", () => {
    process.env.ALLOWED_ORIGINS = "https://exam.example.com,https://exam2.example.com"
    const result = verifyOrigin(requestWithOrigin("https://exam2.example.com"))
    expect(result).toBeNull()
  })

  it("normalizes ALLOWED_ORIGINS entries (trailing slash, default port)", () => {
    process.env.ALLOWED_ORIGINS =
      "https://exam.example.com/, https://exam2.example.com:443"
    expect(verifyOrigin(requestWithOrigin("https://exam.example.com"))).toBeNull()
    expect(verifyOrigin(requestWithOrigin("https://exam2.example.com"))).toBeNull()
  })

  it("falls back to NEXT_PUBLIC_BASE_URL when ALLOWED_ORIGINS is unset", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://exam.example.com"
    expect(verifyOrigin(requestWithOrigin("https://exam.example.com"))).toBeNull()
    expect(verifyOrigin(requestWithOrigin("https://evil.example.com"))?.status).toBe(403)
  })

  it("falls back to localhost:3000 outside production when nothing is configured", () => {
    Object.assign(process.env, { NODE_ENV: "development" })
    expect(verifyOrigin(requestWithOrigin("http://localhost:3000"))).toBeNull()
  })

  it("allows nothing when nothing is configured in production", () => {
    Object.assign(process.env, { NODE_ENV: "production" })
    expect(verifyOrigin(requestWithOrigin("http://localhost:3000"))?.status).toBe(403)
  })
})
