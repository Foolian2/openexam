import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  sendEmail: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { account: { findFirst: mocks.findFirst } },
}))
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }))
vi.mock("@/lib/logger", () => ({
  logDebug: mocks.logDebug,
  logError: mocks.logError,
}))

import {
  scheduleResetPasswordEmail,
  sendResetPasswordEmail,
} from "@/lib/password-reset"
import {
  forgotPasswordSchema,
  resetPasswordSchema,
} from "@/lib/validators/auth"

const input = {
  user: { id: "u1", email: "anna@schule.ch", name: "Anna" },
  url: "https://openexam.ch/api/auth/reset-password/tok%2Fen?callbackURL=%2Freset-password",
  token: "tok/en",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findFirst.mockResolvedValue({ id: "acc1" })
  mocks.sendEmail.mockResolvedValue(undefined)
})

describe("sendResetPasswordEmail", () => {
  it("mails a link that carries the token in the query, never in the path", async () => {
    await sendResetPasswordEmail(input, false)
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", providerId: "credential" },
      select: { id: true },
    })
    const mail = mocks.sendEmail.mock.calls[0][0]
    expect(mail.to).toBe("anna@schule.ch")
    expect(mail.subject).toBe("OpenExam — Passwort zurücksetzen")
    expect(mail.text).toContain(
      "https://openexam.ch/reset-password?token=tok%2Fen"
    )
    expect(mail.text).not.toContain("/api/auth/reset-password/")
    expect(mail.text).toContain("30 Minuten")
  })

  it("sends nothing for an SSO-only account without a password", async () => {
    mocks.findFirst.mockResolvedValue(null)
    await sendResetPasswordEmail(input, false)
    await sendResetPasswordEmail(input, true)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.logDebug).not.toHaveBeenCalled()
  })

  it("logs instead of mailing where no mailbox exists", async () => {
    await sendResetPasswordEmail(input, true)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
    expect(mocks.logDebug).toHaveBeenCalledWith("Reset password link", {
      email: "anna@schule.ch",
      url: "https://openexam.ch/reset-password?token=tok%2Fen",
    })
  })
})

describe("scheduleResetPasswordEmail", () => {
  it("returns before the lookup and SMTP delivery finish (no timing oracle)", async () => {
    let releaseMail!: () => void
    mocks.sendEmail.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseMail = resolve
      })
    )
    await scheduleResetPasswordEmail(input, false)
    // The hook resolved while delivery is still pending.
    await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledOnce())
    releaseMail()
  })

  it("logs a delivery failure instead of failing the request", async () => {
    mocks.sendEmail.mockRejectedValue(new Error("smtp down"))
    await expect(
      scheduleResetPasswordEmail(input, false)
    ).resolves.toBeUndefined()
    await vi.waitFor(() =>
      expect(mocks.logError).toHaveBeenCalledWith(
        "password reset email failed",
        expect.objectContaining({ userId: "u1", err: "smtp down" })
      )
    )
  })
})

describe("password reset validators", () => {
  it("requires a valid email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "x" }).success).toBe(false)
    expect(forgotPasswordSchema.safeParse({ email: "a@b.ch" }).success).toBe(
      true
    )
  })

  it("requires 8–128 characters and matching confirmation", () => {
    const ok = { password: "long-enough", confirmPassword: "long-enough" }
    expect(resetPasswordSchema.safeParse(ok).success).toBe(true)
    expect(
      resetPasswordSchema.safeParse({
        password: "short",
        confirmPassword: "short",
      }).success
    ).toBe(false)
    expect(
      resetPasswordSchema.safeParse({ ...ok, confirmPassword: "different" })
        .success
    ).toBe(false)
    const long = "x".repeat(129)
    expect(
      resetPasswordSchema.safeParse({ password: long, confirmPassword: long })
        .success
    ).toBe(false)
  })
})
