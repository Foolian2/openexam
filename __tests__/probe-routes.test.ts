import { describe, expect, it } from "vitest"
import { PUBLIC_ROUTES } from "@/proxy"

/**
 * Probes have no session — monitoring does not carry a cookie — so a probe
 * behind the auth gate is unreachable by the only thing meant to call it.
 *
 * /api/ready spent its whole existence answering 401 for exactly that reason,
 * while its own route comment described it as a public endpoint. Nothing
 * noticed, because nothing could reach it to notice. These assertions are the
 * cheap check that would have.
 */
describe("probe endpoints are reachable without a session", () => {
  it("exempts the liveness probe, which the Docker HEALTHCHECK calls", () => {
    expect(PUBLIC_ROUTES).toContain("/api/health")
  })

  it("exempts the readiness probe", () => {
    // Safe to expose: it serializes three booleans and nothing else — every
    // underlying error is logged server-side (see app/api/ready/route.ts), so
    // the response discloses only whether the stack is up.
    expect(PUBLIC_ROUTES).toContain("/api/ready")
  })

  it("does not exempt the metrics endpoint, which nginx denies publicly", () => {
    // Public in the proxy only so Prometheus can scrape web:3000 directly over
    // the Docker internal network; nginx blocks the path from outside. The
    // distinction matters — metrics carry operational detail the readiness
    // booleans do not.
    expect(PUBLIC_ROUTES).toContain("/api/metrics")
  })
})
