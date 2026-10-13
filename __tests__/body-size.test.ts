import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, resetInSeconds: 0 })),
}))
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }))

const { readBoundedBytes, readBoundedJson } = await import("@/lib/body-size")

/**
 * A chunked body with no Content-Length, which streams `chunks` chunks of
 * `size` bytes and records how many were actually pulled.
 */
function chunkedRequest(chunks: number, size: number, url = "http://x/") {
  let pulled = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close()
      pulled++
      controller.enqueue(new Uint8Array(size).fill(0x61))
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new NextRequest(url, {
    method: "POST",
    body,
    // Required by Node's fetch for streaming request bodies.
    duplex: "half",
  })
  return { request, stats: () => ({ pulled, cancelled }) }
}

describe("readBoundedBytes", () => {
  it("returns the whole body under the limit", async () => {
    const { request } = chunkedRequest(3, 10)
    const bytes = await readBoundedBytes(request, 100)
    expect(bytes?.byteLength).toBe(30)
  })

  it("stops reading and cancels once the limit is passed", async () => {
    const { request, stats } = chunkedRequest(1000, 1024)
    expect(await readBoundedBytes(request, 4096)).toBeNull()
    expect(stats().pulled).toBeLessThan(10)
    expect(stats().cancelled).toBe(true)
  })

  it("returns an empty array for a request without a body", async () => {
    const bytes = await readBoundedBytes(new NextRequest("http://x/"), 10)
    expect(bytes?.byteLength).toBe(0)
  })
})

describe("readBoundedJson", () => {
  it("answers 413 for an oversized headerless body", async () => {
    const { request } = chunkedRequest(100, 1024)
    const result = await readBoundedJson(request, 4096)
    expect(result).toHaveProperty("status", 413)
  })

  it("parses a small JSON object", async () => {
    const request = new NextRequest("http://x/", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    })
    expect(await readBoundedJson(request, 4096)).toEqual({ a: 1 })
  })
})

describe("monitoring tunnel", () => {
  beforeEach(() => {
    vi.stubEnv("SENTRY_DSN", "http://key@glitchtip-web:8000/1")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null))
    )
  })

  it("rejects a chunked envelope over 5 MB without buffering it", async () => {
    const { POST } = await import("@/app/api/monitoring/tunnel/route")
    // 64 KiB chunks, 100 MB in total if fully read.
    const { request, stats } = chunkedRequest(
      1600,
      64 * 1024,
      "http://x/api/monitoring/tunnel"
    )
    const res = await POST(request)
    expect(res.status).toBe(413)
    // 5 MB is 80 chunks; the stream may pull a chunk or two ahead of the
    // reader. Without the bound all 1600 (100 MB) would be read.
    expect(stats().pulled).toBeLessThan(90)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("forwards a small envelope to the configured instance", async () => {
    const { POST } = await import("@/app/api/monitoring/tunnel/route")
    const envelope =
      JSON.stringify({ dsn: "http://key@glitchtip-web:8000/1" }) + "\n{}\n{}"
    const res = await POST(
      new NextRequest("http://x/api/monitoring/tunnel", {
        method: "POST",
        body: envelope,
      })
    )
    expect(res.status).toBe(200)
    expect(fetch).toHaveBeenCalledWith(
      "http://glitchtip-web:8000/api/1/envelope/",
      expect.objectContaining({ method: "POST" })
    )
  })
})
