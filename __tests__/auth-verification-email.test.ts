import { beforeEach, describe, expect, it, vi } from "vitest"
import { accountKey } from "@/lib/account-rate-limit"

// The verification hook also sends the second step of an email change: once
// the old mailbox confirms, better-auth calls it with the NEW address. Its
// cooldown used to be keyed on the user alone, so that mail was silently
// dropped whenever another verification mail had gone out in the window.
const { redisMock, sendEmailMock } = vi.hoisted(() => ({
  redisMock: { set: vi.fn(), eval: vi.fn() },
  sendEmailMock: vi.fn(),
}))
vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }))

process.env = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://openexam:pw@localhost:5432/openexam",
  NEXT_PUBLIC_BASE_URL: "https://exam.example.com",
  BETTER_AUTH_URL: "https://exam.example.com",
  BETTER_AUTH_SECRET: "x".repeat(40),
} as unknown as NodeJS.ProcessEnv

const user = {
  id: "user-1",
  name: "Maxi",
  email: "old@example.com",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

async function sendVerification(email: string) {
  const { auth } = await import("@/lib/auth")
  await auth.options.emailVerification!.sendVerificationEmail!({
    user: { ...user, email },
    url: "https://exam.example.com/api/auth/verify-email?token=t",
    token: "t",
  })
}

describe(
  "emailVerification.sendVerificationEmail cooldown",
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      redisMock.set.mockReset()
      // Aggregate per-user budget: first mail of the window.
      redisMock.eval.mockReset().mockResolvedValue([1, 3600])
      sendEmailMock.mockReset()
    })

    it("keys the cooldown on user and hashed address", async () => {
      redisMock.set.mockResolvedValue("OK")
      await sendVerification("New@Example.com")
      expect(accountKey("New@Example.com")).toBe(accountKey("new@example.com"))
      expect(redisMock.set).toHaveBeenCalledWith(
        `verify-email:cooldown:user-1:${accountKey("new@example.com")}`,
        "1",
        "EX",
        300,
        "NX"
      )
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "New@Example.com" })
      )
    })

    it("still sends to a new address after a recent mail to the old one", async () => {
      const held = new Set<string>()
      redisMock.set.mockImplementation(async (key: string) => {
        if (held.has(key)) return null
        held.add(key)
        return "OK"
      })
      await sendVerification("old@example.com")
      await sendVerification("new@example.com")
      expect(sendEmailMock.mock.calls.map(([m]) => m.to)).toEqual([
        "old@example.com",
        "new@example.com",
      ])
    })

    it("throttles repeat mails to the same address", async () => {
      redisMock.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null)
      await sendVerification("new@example.com")
      await sendVerification("new@example.com")
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it("stops at the per-user budget across distinct addresses", async () => {
      redisMock.set.mockResolvedValue("OK")
      redisMock.eval.mockResolvedValue([11, 1800])
      await sendVerification("a@example.com")
      expect(redisMock.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        "ratelimit:account-mail:user-1",
        3600
      )
      expect(sendEmailMock).not.toHaveBeenCalled()
    })
  }
)
