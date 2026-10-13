import { describe, expect, it } from "vitest"
import { authErrorMessage } from "@/lib/auth-error-message"

const FALLBACK = "Anmeldung fehlgeschlagen."

describe("authErrorMessage", () => {
  it("translates a wrong email or password", () => {
    expect(
      authErrorMessage(
        {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
          status: 401,
        },
        FALLBACK
      )
    ).toBe("E-Mail-Adresse oder Passwort ist falsch.")
  })

  it("translates rate limiting, which carries no code", () => {
    expect(
      authErrorMessage(
        { message: "Too many requests. Please try again later.", status: 429 },
        FALLBACK
      )
    ).toMatch(/^Zu viele Versuche/)
  })

  it("keeps the per-account throttle's message with its wait time", () => {
    const message =
      "Zu viele Anmeldeversuche für dieses Konto. Bitte in 15 Minuten erneut versuchen."
    expect(
      authErrorMessage(
        { code: "ACCOUNT_RATE_LIMITED", message, status: 429 },
        FALLBACK
      )
    ).toBe(message)
  })

  it("keeps the app's own German messages", () => {
    const message =
      "Bitte bestätigen Sie, dass Sie die Datenschutzerklärung gelesen haben."
    expect(
      authErrorMessage(
        { code: "PRIVACY_NOT_ACCEPTED", message, status: 400 },
        FALLBACK
      )
    ).toBe(message)
  })

  it("never shows an untranslated English message", () => {
    expect(
      authErrorMessage(
        {
          code: "CAPTCHA_VERIFICATION_FAILED",
          message: "Captcha verification failed",
          status: 403,
        },
        FALLBACK
      )
    ).toBe(FALLBACK)
    expect(authErrorMessage({ message: "Something broke" }, FALLBACK)).toBe(
      FALLBACK
    )
  })

  it("falls back when there is no error object", () => {
    expect(authErrorMessage(null, FALLBACK)).toBe(FALLBACK)
  })

  it("keeps the display-name check's German message", () => {
    expect(
      authErrorMessage(
        {
          code: "INVALID_NAME",
          message: "Name muss mindestens 2 Zeichen haben",
          status: 400,
        },
        FALLBACK
      )
    ).toBe("Name muss mindestens 2 Zeichen haben")
  })
})
