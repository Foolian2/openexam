import { describe, expect, it } from "vitest"
import { safeRedirectPath } from "@/lib/safe-redirect"

describe("safeRedirectPath", () => {
  it("accepts same-origin absolute paths, including query and fragment", () => {
    expect(safeRedirectPath("/exam/abc123/take")).toBe("/exam/abc123/take")
    expect(safeRedirectPath("/dashboard/student?tab=open")).toBe(
      "/dashboard/student?tab=open"
    )
    expect(safeRedirectPath("/")).toBe("/")
  })

  it("returns null for nothing to redirect to", () => {
    expect(safeRedirectPath(null)).toBeNull()
    expect(safeRedirectPath(undefined)).toBeNull()
    expect(safeRedirectPath("")).toBeNull()
  })

  it("rejects absolute and schemeless off-site URLs", () => {
    expect(safeRedirectPath("https://evil.example/login")).toBeNull()
    expect(safeRedirectPath("http://evil.example")).toBeNull()
    expect(safeRedirectPath("evil.example")).toBeNull()
    expect(safeRedirectPath("javascript:alert(1)")).toBeNull()
  })

  it("rejects protocol-relative URLs, the bypass a bare startsWith('/') check misses", () => {
    // Browsers resolve both of these against the current scheme and navigate
    // off-site, despite the leading slash.
    expect(safeRedirectPath("//evil.example/login")).toBeNull()
    expect(safeRedirectPath("/\\evil.example/login")).toBeNull()
  })

  it("rejects control characters that could split or truncate the Location header", () => {
    expect(safeRedirectPath("/dashboard\r\nSet-Cookie: a=b")).toBeNull()
    expect(safeRedirectPath("/dashboard\u0000")).toBeNull()
  })
})
