import { describe, expect, it } from "vitest"
import {
  displayNameIssue,
  displayNameSchema,
  normalizeDisplayName,
} from "@/lib/display-name"

describe("displayNameSchema", () => {
  it("trims surrounding spaces", () => {
    expect(displayNameSchema.parse("  Lea Müller ")).toBe("Lea Müller")
  })

  it("rejects a name of only spaces", () => {
    expect(displayNameSchema.safeParse("     ").success).toBe(false)
  })

  it("rejects names over 100 characters", () => {
    expect(displayNameSchema.safeParse("x".repeat(101)).success).toBe(false)
  })
})

describe("displayNameIssue", () => {
  it("checks the name on sign-up and profile updates", () => {
    expect(displayNameIssue("/sign-up/email", { name: "   " })).toMatch(
      /mindestens 2/
    )
    expect(
      displayNameIssue("/update-user", { name: "x".repeat(5000) })
    ).toMatch(/maximal 100/)
    expect(displayNameIssue("/update-user", { name: "Lea" })).toBeNull()
  })

  it("lets other updates and other paths through", () => {
    expect(displayNameIssue("/update-user", { highContrast: true })).toBeNull()
    expect(displayNameIssue("/sign-in/email", { name: "" })).toBeNull()
    expect(displayNameIssue(undefined, { name: "" })).toBeNull()
  })

  it("requires a name on sign-up", () => {
    expect(displayNameIssue("/sign-up/email", {})).not.toBeNull()
  })
})

describe("normalizeDisplayName", () => {
  it("drops padding that would slip past the length check", () => {
    const padded = "x".repeat(100) + " ".repeat(5000)
    expect(displayNameIssue("/update-user", { name: padded })).toBeNull()
    expect(normalizeDisplayName(padded)).toHaveLength(100)
  })
})
