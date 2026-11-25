import { beforeEach, describe, expect, it, vi } from "vitest"

const rateLimit = vi.hoisted(() => vi.fn())
const evalScript = vi.hoisted(() => vi.fn())
vi.mock("@/lib/rate-limit", () => ({ rateLimit }))
vi.mock("@/lib/redis", () => ({ redis: { eval: evalScript } }))

import { APIError } from "better-auth/api"
import { BASE_ERROR_CODES } from "better-auth"
import {
  accountKey,
  accountRateLimitMessage,
  isInvalidCredentials,
  reserveSignInAttempt,
  settleSignInAttempt,
} from "@/lib/account-rate-limit"

beforeEach(() => {
  evalScript.mockReset()
  evalScript.mockResolvedValue(1)
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
  const KEYS = [
    "ratelimit:login-failed-ip:203.0.113.7",
    "ratelimit:login-pending-ip:203.0.113.7",
  ]

  it("reserves an in-flight slot against 50 failures before the password check", async () => {
    expect(
      await reserveSignInAttempt("/sign-in/email", "203.0.113.7")
    ).toBeNull()
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining("failed + pending"),
      2,
      ...KEYS,
      50,
      60
    )
  })

  it("refuses password sign-in from the IP once failures + in-flight reach the limit", async () => {
    evalScript.mockResolvedValue(0)
    expect(await reserveSignInAttempt("/sign-in/email", "203.0.113.7")).toMatch(
      /Zu viele fehlgeschlagene Anmeldungen/
    )
  })

  it("settles the slot, counting only failures for 15 minutes", async () => {
    await settleSignInAttempt("/sign-in/email", "203.0.113.7", true)
    expect(evalScript).toHaveBeenLastCalledWith(
      expect.stringContaining("DECR"),
      2,
      ...KEYS,
      "1",
      900
    )
    await settleSignInAttempt("/sign-in/email", "203.0.113.7", false)
    expect(evalScript).toHaveBeenLastCalledWith(
      expect.stringContaining("DECR"),
      2,
      ...KEYS,
      "0",
      900
    )
  })

  it("fails open when Redis is unreachable", async () => {
    evalScript.mockRejectedValue(new Error("down"))
    expect(
      await reserveSignInAttempt("/sign-in/email", "203.0.113.7")
    ).toBeNull()
    await expect(
      settleSignInAttempt("/sign-in/email", "203.0.113.7", true)
    ).resolves.toBeUndefined()
  })

  it("ignores other endpoints and requests without a client IP", async () => {
    expect(
      await reserveSignInAttempt("/sign-up/email", "203.0.113.7")
    ).toBeNull()
    expect(await reserveSignInAttempt("/sign-in/email", null)).toBeNull()
    await settleSignInAttempt("/sign-in/social", "203.0.113.7", true)
    await settleSignInAttempt("/sign-in/email", null, true)
    expect(evalScript).not.toHaveBeenCalled()
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
