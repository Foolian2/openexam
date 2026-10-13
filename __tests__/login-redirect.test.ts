import { describe, expect, it } from "vitest"
import { loginRedirectUrl, safeRedirectTo } from "@/lib/login-redirect"

describe("loginRedirectUrl", () => {
  it("encodes the target path as a next param", () => {
    expect(loginRedirectUrl("/dashboard/teacher")).toBe(
      "/login?next=%2Fdashboard%2Fteacher"
    )
  })

  it("preserves query strings", () => {
    expect(loginRedirectUrl("/dashboard/teacher?page=2&q=mathe")).toBe(
      "/login?next=%2Fdashboard%2Fteacher%3Fpage%3D2%26q%3Dmathe"
    )
  })
})

describe("safeRedirectTo", () => {
  it("falls back to /dashboard when missing", () => {
    expect(safeRedirectTo(undefined)).toBe("/dashboard")
    expect(safeRedirectTo("")).toBe("/dashboard")
  })

  it("accepts a plain internal path", () => {
    expect(safeRedirectTo("/dashboard/teacher/monitor/abc")).toBe(
      "/dashboard/teacher/monitor/abc"
    )
  })

  it("accepts a path with query string", () => {
    expect(safeRedirectTo("/dashboard/teacher?page=2")).toBe(
      "/dashboard/teacher?page=2"
    )
  })

  it("rejects protocol-relative URLs", () => {
    expect(safeRedirectTo("//evil.com")).toBe("/dashboard")
  })

  it("rejects backslash tricks that browsers resolve as protocol-relative", () => {
    expect(safeRedirectTo("/\\evil.example")).toBe("/dashboard")
    expect(safeRedirectTo("/\\/evil.example")).toBe("/dashboard")
  })

  it("rejects absolute URLs", () => {
    expect(safeRedirectTo("https://evil.com")).toBe("/dashboard")
    expect(safeRedirectTo("http://evil.com/x")).toBe("/dashboard")
  })

  it("rejects non-path values", () => {
    expect(safeRedirectTo("dashboard")).toBe("/dashboard")
    expect(safeRedirectTo("javascript:alert(1)")).toBe("/dashboard")
  })

  it("rejects redirects back into auth pages", () => {
    expect(safeRedirectTo("/login")).toBe("/dashboard")
    expect(safeRedirectTo("/register")).toBe("/dashboard")
    expect(safeRedirectTo("/verify-email")).toBe("/dashboard")
  })

  it("honours a custom fallback", () => {
    expect(safeRedirectTo(undefined, "/dashboard/student")).toBe(
      "/dashboard/student"
    )
  })
})
