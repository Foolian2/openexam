import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
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

describe("anonymous monitoring ingestion", () => {
  const ORIGIN = "http://localhost:3000"

  function request(path: string, origin: string | null = ORIGIN) {
    const headers = new Headers()
    if (origin) headers.set("origin", origin)
    return new NextRequest(`http://localhost:3000${path}`, {
      method: "POST",
      headers,
    })
  }

  function entryNames(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return [name, ...(statSync(path).isDirectory() ? entryNames(path) : [])]
    })
  }

  it("allows only the exact tunnel route after validating Origin", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      const allowed = await proxy(request("/api/monitoring/tunnel"))
      expect(allowed.status).toBe(200)
      // Continuation marker: the request proceeds to the tunnel route.
      expect(allowed.headers.get("x-middleware-next")).toBe("1")
      expect(
        (await proxy(request("/api/monitoring/tunnel/nested"))).status
      ).toBe(401)
      expect(
        (await proxy(request("/api/monitoring/tunnel", "https://evil.example")))
          .status
      ).toBe(403)
      // The exception never bypasses the Origin gate.
      expect(
        (await proxy(request("/api/monitoring/tunnel", null))).status
      ).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does not admit variant spellings of the tunnel route", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      // proxy.ts compares the pathname exactly: a trailing or encoded slash
      // must not ride the anonymous exception into the route.
      expect((await proxy(request("/api/monitoring/tunnel/"))).status).toBe(401)
      expect((await proxy(request("/api/monitoring/tunnel%2F"))).status).toBe(
        401
      )
      expect(
        (await proxy(request("/api/monitoring/tunnel%2fnested"))).status
      ).toBe(401)
      // Repeated slashes never reach the proxy in production: the router
      // 308-redirects them first (next/dist/server/lib/router-utils/
      // resolve-routes.js). Reached directly they must still not be admitted.
      const doubled = await proxy(request("//api/monitoring/tunnel"))
      expect(doubled.status).toBe(307)
      expect(doubled.headers.get("location")).toContain("/login")
      // Standard URL dot-segment resolution collapses this to the exact
      // route — the same endpoint, still behind the Origin gate above.
      expect(
        (await proxy(request("/api/monitoring/tunnel/%2E%2E/tunnel"))).status
      ).toBe(200)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("admits the backslash spelling only via WHATWG normalization", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      // WHATWG URL parsing turns `\` into `/` in an http path before proxy()
      // ever sees the request, so `/api/monitoring\tunnel` arrives as the
      // exact pathname and the anonymous exception admits it. That is safe
      // only because routing normalizes the same way: the admitted request
      // can only reach the static tunnel route itself. A dynamic route
      // under /api/monitoring/ could instead claim the raw `\tunnel`
      // segment through the exception — the directory pin below fails if
      // one is ever added.
      const backslashed = request("/api/monitoring\\tunnel")
      expect(backslashed.nextUrl.pathname).toBe("/api/monitoring/tunnel")
      const res = await proxy(backslashed)
      expect(res.status).toBe(200)
      expect(res.headers.get("x-middleware-next")).toBe("1")
      // Normalization must not skip the Origin gate on the way in.
      expect(
        (await proxy(request("/api/monitoring\\tunnel", null))).status
      ).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps /api/monitoring free of dynamic routes", () => {
    // Routing pin for the backslash normalization above: only the static
    // tunnel route may live under /api/monitoring/. A bracket segment there
    // could serve a path the anonymous exception was never meant to admit.
    const monitoringDir = join(process.cwd(), "app", "api", "monitoring")
    expect(entryNames(monitoringDir).filter((n) => n.includes("["))).toEqual([])
  })

  it("collapses plain dot segments before the admission check", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      // Dot-segment resolution also runs before proxy(): a path that
      // resolves to the exact tunnel route is the same endpoint, still
      // behind the Origin gate.
      const resolved = request("/api/monitoring/../monitoring/tunnel")
      expect(resolved.nextUrl.pathname).toBe("/api/monitoring/tunnel")
      expect((await proxy(resolved)).status).toBe(200)
      // Walking back out of the route drops below the exact match.
      expect((await proxy(request("/api/monitoring/tunnel/.."))).status).toBe(
        401
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("resolves %2e%2e dot segments but never encoded slashes", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      // `%2e%2e` counts as a double-dot segment even percent-encoded, so it
      // resolves away from the tunnel route and is denied.
      const up = request("/api/monitoring/%2e%2e/tunnel")
      expect(up.nextUrl.pathname).toBe("/api/tunnel")
      expect((await proxy(up)).status).toBe(401)
      const out = request("/api/monitoring/tunnel/%2e%2e")
      expect(out.nextUrl.pathname).toBe("/api/monitoring/")
      expect((await proxy(out)).status).toBe(401)
      // `%2e%2e%2f` is one literal segment — %2f is never a separator — so
      // the pathname cannot become the tunnel route.
      const encoded = request("/api/monitoring/%2e%2e%2ftunnel")
      expect(encoded.nextUrl.pathname).toBe("/api/monitoring/%2e%2e%2ftunnel")
      expect((await proxy(encoded)).status).toBe(401)
      // Encoded separators throughout: never the tunnel route.
      const all = request("/api%2Fmonitoring%2Ftunnel")
      expect(all.nextUrl.pathname).toBe("/api%2Fmonitoring%2Ftunnel")
      expect((await proxy(all)).status).toBe(307)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("treats case variants as different paths", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      // Pathnames are case-sensitive: the exception must not fold case.
      // /API/... misses the /api/ prefix entirely and gets the login
      // redirect, not a continuation.
      const upper = await proxy(request("/API/monitoring/tunnel"))
      expect(upper.status).toBe(307)
      expect(upper.headers.get("location")).toContain("/login")
      expect(upper.headers.get("x-middleware-next")).toBeNull()
      expect((await proxy(request("/api/Monitoring/tunnel"))).status).toBe(401)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps repeated-slash API paths out of the public prefix", async () => {
    vi.stubEnv("ALLOWED_ORIGINS", ORIGIN)
    try {
      // Pins the `/`-prefix auth bypass fix independently of the monitoring
      // exception: `//api/...` must not ride PUBLIC_ROUTES' root entry into
      // an authenticated API route with no session cookie. Next's router
      // 308-normalizes repeated slashes before the proxy in production
      // (next/dist/server/lib/router-utils/resolve-routes.js), but reached
      // directly the proxy must deny — login redirect, no continuation
      // marker, so no handler ever runs.
      for (const path of ["//api/exams/e", "//api/exams/e/publish"]) {
        const res = await proxy(request(path))
        expect(res.status).toBe(307)
        expect(res.headers.get("location")).toContain("/login")
        expect(res.headers.get("x-middleware-next")).toBeNull()
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
