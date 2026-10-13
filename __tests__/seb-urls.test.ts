import { describe, expect, it } from "vitest"
import {
  sebBaseUrl,
  takeUrl,
  requireSebBaseUrl,
  publicRequestUrl,
} from "@/lib/seb-urls"

describe("sebBaseUrl", () => {
  it("returns NEXT_PUBLIC_BASE_URL when set", () => {
    expect(
      sebBaseUrl({ NEXT_PUBLIC_BASE_URL: "https://exam.example.com" })
    ).toBe("https://exam.example.com")
  })

  it("falls back to localhost when unset", () => {
    expect(sebBaseUrl({})).toBe("http://localhost:3000")
  })

  // Regression: a present-but-empty NEXT_PUBLIC_BASE_URL must fall back the
  // same way an unset one does, mirroring ws-backend's firstNonEmpty (which
  // treats "" as unset). `??` alone doesn't catch this — only `||` does —
  // and a mismatch here means the Go WS verifier and this TS helper hash
  // Config Key tokens against different origins, silently failing every SEB
  // handshake.
  it("falls back to localhost when NEXT_PUBLIC_BASE_URL is present but empty", () => {
    expect(sebBaseUrl({ NEXT_PUBLIC_BASE_URL: "" })).toBe(
      "http://localhost:3000"
    )
  })
})

describe("takeUrl", () => {
  it("builds the absolute take-page URL from the base origin", () => {
    expect(
      takeUrl("exam1", { NEXT_PUBLIC_BASE_URL: "https://exam.example.com" })
    ).toBe("https://exam.example.com/exam/exam1/take")
  })

  it("stays absolute even when NEXT_PUBLIC_BASE_URL is empty", () => {
    expect(takeUrl("exam1", { NEXT_PUBLIC_BASE_URL: "" })).toBe(
      "http://localhost:3000/exam/exam1/take"
    )
  })
})

describe("requireSebBaseUrl", () => {
  it("returns the value when set", () => {
    expect(
      requireSebBaseUrl({ NEXT_PUBLIC_BASE_URL: "https://exam.example.com" })
    ).toBe("https://exam.example.com")
  })

  it("throws when unset", () => {
    expect(() => requireSebBaseUrl({})).toThrow(/NEXT_PUBLIC_BASE_URL/)
  })

  it("throws when present but empty", () => {
    expect(() => requireSebBaseUrl({ NEXT_PUBLIC_BASE_URL: "" })).toThrow(
      /NEXT_PUBLIC_BASE_URL/
    )
  })
})

describe("publicRequestUrl", () => {
  const env = { NEXT_PUBLIC_BASE_URL: "https://openexam.ch" }

  it("substitutes the configured public origin for the container's internal one", () => {
    // The bug this exists for: behind nginx the web container reports its own
    // bind address, so request.url was http://0.0.0.0:3000/api/sessions/abc
    // while SEB hashed https://openexam.ch/api/sessions/abc. On Windows, where
    // SEB's native header overwrites the take-page token and the per-URL
    // candidate is the only one that can match, every student got a 403.
    expect(
      publicRequestUrl(
        { nextUrl: { pathname: "/api/sessions/abc", search: "" } },
        env
      )
    ).toBe("https://openexam.ch/api/sessions/abc")
  })

  it("preserves the query string, which is part of what SEB hashed", () => {
    expect(
      publicRequestUrl(
        { nextUrl: { pathname: "/api/sessions/abc", search: "?q=1&r=2" } },
        env
      )
    ).toBe("https://openexam.ch/api/sessions/abc?q=1&r=2")
  })

  it("agrees with takeUrl for the take page, so both Config Key candidates are built from one origin", () => {
    expect(
      publicRequestUrl(
        { nextUrl: { pathname: "/exam/exam1/take", search: "" } },
        env
      )
    ).toBe(takeUrl("exam1", env))
  })
})
