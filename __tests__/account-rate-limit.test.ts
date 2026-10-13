import { beforeEach, describe, expect, it, vi } from "vitest"

const rateLimit = vi.hoisted(() => vi.fn())
vi.mock("@/lib/rate-limit", () => ({ rateLimit }))

import { accountKey, accountRateLimitMessage } from "@/lib/account-rate-limit"

beforeEach(() => {
  rateLimit.mockReset()
  rateLimit.mockResolvedValue({
    allowed: true,
    remaining: 1,
    resetInSeconds: 1,
  })
})

describe("per-account credential throttle", () => {
  it("limits sign-in to 10 attempts per 15 minutes per account, fail-open", async () => {
    expect(
      await accountRateLimitMessage("/sign-in/email", {
        email: "Anna@Example.CH ",
      })
    ).toBeNull()
    expect(rateLimit).toHaveBeenCalledWith(
      `login-account:${accountKey("anna@example.ch")}`,
      10,
      900,
      "open"
    )
  })

  it("normalizes case and whitespace and keeps the address out of the key", () => {
    expect(accountKey(" Anna@Example.CH")).toBe(accountKey("anna@example.ch"))
    expect(accountKey("anna@example.ch")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("limits reset requests to 3 per hour per account", async () => {
    await accountRateLimitMessage("/request-password-reset", {
      email: "a@b.ch",
    })
    expect(rateLimit).toHaveBeenCalledWith(
      `password-reset-account:${accountKey("a@b.ch")}`,
      3,
      3600,
      "open"
    )
  })

  it("returns the German message once the account is over its limit", async () => {
    rateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetInSeconds: 600,
    })
    expect(
      await accountRateLimitMessage("/sign-in/email", { email: "a@b.ch" })
    ).toMatch(/Zu viele Anmeldeversuche/)
  })

  it("ignores other endpoints and bodies without an email", async () => {
    expect(
      await accountRateLimitMessage("/sign-up/email", { email: "a@b.ch" })
    ).toBeNull()
    expect(await accountRateLimitMessage("/sign-in/email", {})).toBeNull()
    expect(await accountRateLimitMessage("/sign-in/email", null)).toBeNull()
    expect(rateLimit).not.toHaveBeenCalled()
  })
})
