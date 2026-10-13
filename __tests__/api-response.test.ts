import { describe, expect, it } from "vitest"
import { ApiError, rateLimited, unauthorized } from "@/lib/api-response"

describe("api-response", () => {
  it("ApiError.toResponse replies with the shared envelope and its status", async () => {
    const err = new ApiError(409, "CONFLICT", "Prüfung ist nicht aktiv")
    const res = err.toResponse()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: { code: "CONFLICT", message: "Prüfung ist nicht aktiv" },
    })
  })

  it("rateLimited always sets Retry-After", () => {
    const res = rateLimited(42)
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("42")
  })

  it("unauthorized keeps the default German message", async () => {
    expect(await unauthorized().json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Nicht angemeldet" },
    })
  })
})
