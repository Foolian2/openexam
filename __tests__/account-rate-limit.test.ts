import { beforeEach, describe, expect, it, vi } from "vitest"

const rateLimit = vi.hoisted(() => vi.fn())
const underRateLimit = vi.hoisted(() => vi.fn())
vi.mock("@/lib/rate-limit", () => ({ rateLimit, underRateLimit }))

import { APIError } from "better-auth/api"
import { BASE_ERROR_CODES } from "better-auth"
import {
  accountKey,
  accountRateLimitMessage,
  failedSignInMessage,
  isInvalidCredentials,
  recordFailedSignIn,
} from "@/lib/account-rate-limit"

beforeEach(() => {
  underRateLimit.mockReset()
  underRateLimit.mockResolvedValue(true)
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

describe("per-IP failed sign-in throttle", () => {
  it("counts a failure against the IP: 50 per 15 minutes, fail-open", async () => {
    await recordFailedSignIn("203.0.113.7")
    expect(rateLimit).toHaveBeenCalledWith(
      "login-failed-ip:203.0.113.7",
      50,
      900,
      "open"
    )
  })

  it("only reads the counter before a sign-in, so successes are never counted", async () => {
    expect(
      await failedSignInMessage("/sign-in/email", "203.0.113.7")
    ).toBeNull()
    expect(underRateLimit).toHaveBeenCalledWith(
      "login-failed-ip:203.0.113.7",
      50
    )
    expect(rateLimit).not.toHaveBeenCalled()
  })

  it("refuses every password sign-in from the IP once over the limit", async () => {
    underRateLimit.mockResolvedValue(false)
    expect(await failedSignInMessage("/sign-in/email", "203.0.113.7")).toMatch(
      /Zu viele fehlgeschlagene Anmeldungen/
    )
  })

  it("ignores other endpoints and requests without a client IP", async () => {
    underRateLimit.mockResolvedValue(false)
    expect(
      await failedSignInMessage("/sign-up/email", "203.0.113.7")
    ).toBeNull()
    expect(await failedSignInMessage("/sign-in/email", null)).toBeNull()
    await recordFailedSignIn(null)
    expect(underRateLimit).not.toHaveBeenCalled()
    expect(rateLimit).not.toHaveBeenCalled()
  })

  it("recognises better-auth's wrong email/password error and nothing else", () => {
    expect(
      isInvalidCredentials(
        APIError.from(
          "UNAUTHORIZED",
          BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD
        )
      )
    ).toBe(true)
    // An unverified address means the password was right.
    expect(
      isInvalidCredentials(
        APIError.from("FORBIDDEN", BASE_ERROR_CODES.EMAIL_NOT_VERIFIED)
      )
    ).toBe(false)
    expect(isInvalidCredentials({ token: "t", user: {} })).toBe(false)
    expect(isInvalidCredentials(undefined)).toBe(false)
  })
})
