import { beforeAll, describe, expect, it } from "vitest"
import {
  verifiedEmailChange,
  withEmailChangeState,
} from "@/lib/email-change-state"

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "x".repeat(40)
})

// The change-email link as better-auth builds it (callbackURL encoded).
const link = `https://exam.example.com/api/auth/verify-email?token=t&callbackURL=${encodeURIComponent("/dashboard/student/settings")}`

function stateFrom(url: string): string | null {
  const callback = new URL(url).searchParams.get("callbackURL")!
  return new URL(callback, "http://x").searchParams.get("emailChange")
}

describe("email-change state", () => {
  it("round-trips the address for the user it was signed for", () => {
    const url = withEmailChangeState(link, "user-1", "New@Example.com")
    const callback = new URL(url).searchParams.get("callbackURL")!
    expect(
      callback.startsWith("/dashboard/student/settings?emailChange=")
    ).toBe(true)
    // No `&`: better-auth copies the callbackURL into the second link.
    expect(callback).not.toContain("&")
    expect(verifiedEmailChange(stateFrom(url)!, "user-1")).toBe(
      "New@Example.com"
    )
  })

  it("rejects a value signed for another user", () => {
    const url = withEmailChangeState(link, "user-1", "new@example.com")
    expect(verifiedEmailChange(stateFrom(url)!, "user-2")).toBeNull()
  })

  it("rejects an unsigned or tampered value", () => {
    expect(verifiedEmailChange("new@example.com", "user-1")).toBeNull()
    expect(verifiedEmailChange(undefined, "user-1")).toBeNull()
    expect(verifiedEmailChange(["a", "b"], "user-1")).toBeNull()
    const url = withEmailChangeState(link, "user-1", "new@example.com")
    const [, sig] = stateFrom(url)!.split(".")
    const forged = `${Buffer.from("evil@example.com").toString("base64url")}.${sig}`
    expect(verifiedEmailChange(forged, "user-1")).toBeNull()
  })

  it("leaves a link without callbackURL unchanged", () => {
    const bare = "https://exam.example.com/api/auth/verify-email?token=t"
    expect(withEmailChangeState(bare, "user-1", "a@example.com")).toBe(bare)
  })
})
