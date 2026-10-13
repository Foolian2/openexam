import { describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { getClientIp } from "@/lib/client-ip"

function requestWith(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/sessions", { headers })
}

describe("getClientIp", () => {
  it("returns the value of a single X-Forwarded-For entry", () => {
    const req = requestWith({ "x-forwarded-for": "203.0.113.7" })
    expect(getClientIp(req)).toBe("203.0.113.7")
  })

  it("takes the first entry of a comma list", () => {
    const req = requestWith({ "x-forwarded-for": "203.0.113.7, 198.51.100.2" })
    expect(getClientIp(req)).toBe("203.0.113.7")
  })

  it("returns null when the header is absent and there is no socket IP", () => {
    expect(getClientIp(requestWith({}))).toBeNull()
  })

  it("ignores whitespace padding", () => {
    const req = requestWith({ "x-forwarded-for": "  203.0.113.7  " })
    expect(getClientIp(req)).toBe("203.0.113.7")
  })

  it("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const req = requestWith({ "x-real-ip": "198.51.100.42" })
    expect(getClientIp(req)).toBe("198.51.100.42")
  })

  it("trims whitespace on the X-Real-IP fallback", () => {
    const req = requestWith({ "x-real-ip": "  198.51.100.42  " })
    expect(getClientIp(req)).toBe("198.51.100.42")
  })

  it("prefers X-Forwarded-For over X-Real-IP when both are present", () => {
    const req = requestWith({
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "198.51.100.42",
    })
    expect(getClientIp(req)).toBe("203.0.113.7")
  })
})
