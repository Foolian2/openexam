import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { proxy } from "@/proxy"

function requestWithOrigin(origin: string | null) {
  const headers = new Headers()
  if (origin) headers.set("origin", origin)
  return new NextRequest("http://localhost:3000/api/sessions", {
    method: "POST",
    headers,
  })
}

describe("proxy origin gate", () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    delete process.env.ALLOWED_ORIGINS
    delete process.env.NEXT_PUBLIC_BASE_URL
    delete process.env.BETTER_AUTH_URL
    Object.assign(process.env, { NODE_ENV: "development" })
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it("allows an Origin listed in ALLOWED_ORIGINS even when BASE_URL differs", async () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000"
    process.env.NEXT_PUBLIC_BASE_URL = "http://192.168.1.50:3000"
    const res = await proxy(requestWithOrigin("http://localhost:3000"))
    expect(res.status).not.toBe(403)
  })

  it("rejects an Origin in no allowlist", async () => {
    process.env.ALLOWED_ORIGINS = "https://exam.example.com"
    const res = await proxy(requestWithOrigin("https://evil.example.com"))
    expect(res.status).toBe(403)
  })

  it("rejects the opaque 'null' origin", async () => {
    process.env.ALLOWED_ORIGINS = "http://localhost:3000"
    const res = await proxy(requestWithOrigin("null"))
    expect(res.status).toBe(403)
  })

  it("treats a default-port variant of an allowed origin as allowed", async () => {
    process.env.ALLOWED_ORIGINS = "http://localhost"
    const res = await proxy(requestWithOrigin("http://localhost:80"))
    expect(res.status).not.toBe(403)
  })

  it("rejects a mutating request without an Origin header", async () => {
    const res = await proxy(requestWithOrigin(null))
    expect(res.status).toBe(403)
  })

  it("applies the Origin gate to public API routes too", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:3000/api/teacher/register", {
        method: "POST",
      })
    )
    expect(res.status).toBe(403)
  })

  it("does not require an Origin on safe methods", async () => {
    const res = await proxy(
      new NextRequest("http://localhost:3000/api/health", { method: "GET" })
    )
    expect(res.status).not.toBe(403)
  })
})
