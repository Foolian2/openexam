import { describe, expect, it } from "vitest"
import {
  MIN_PASSWORD_LENGTH,
  parseCreateTeacherArgs,
} from "../scripts/create-teacher"

const TEST_PW = "correct-horse-battery"

describe("parseCreateTeacherArgs", () => {
  it("parses flags, lowercases the email and defaults the role to TEACHER", () => {
    const result = parseCreateTeacherArgs(
      ["--email", "Anna.Muster@Example-School.CH", "--name", "Anna Muster"],
      { TEACHER_PASSWORD: TEST_PW }
    )
    expect(result).toEqual({
      ok: true,
      options: {
        email: "anna.muster@example-school.ch",
        name: "Anna Muster",
        role: "TEACHER",
        password: TEST_PW,
        resetPassword: false,
      },
    })
  })

  it("accepts --flag=value and a lowercase role", () => {
    const result = parseCreateTeacherArgs(
      ["--email=a@b.ch", "--name=Admin Person", "--role=admin"],
      { TEACHER_PASSWORD: TEST_PW }
    )
    expect(result.ok && result.options.role).toBe("ADMIN")
  })

  it("never reads the password from argv", () => {
    const result = parseCreateTeacherArgs(
      ["--email", "a@b.ch", "--name", "A B", "--password", TEST_PW],
      {}
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toContain("unknown argument: --password")
      expect(result.errors).toContain(
        "TEACHER_PASSWORD must be set in the environment"
      )
    }
  })

  it("rejects short passwords, bad emails and unknown roles", () => {
    const result = parseCreateTeacherArgs(
      ["--email", "not-an-email", "--name", "A B", "--role", "STUDENT"],
      { TEACHER_PASSWORD: "x".repeat(MIN_PASSWORD_LENGTH - 1) }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "--email must be a valid email address",
          "--role must be TEACHER or ADMIN",
          `TEACHER_PASSWORD needs at least ${MIN_PASSWORD_LENGTH} characters`,
        ])
      )
    }
  })

  it("reports missing --email and --name", () => {
    const result = parseCreateTeacherArgs([], { TEACHER_PASSWORD: TEST_PW })
    expect(result).toEqual({
      ok: false,
      errors: ["--email is required", "--name is required"],
    })
  })

  it("does not need --name for a password reset", () => {
    const result = parseCreateTeacherArgs(
      ["--email", "a@b.ch", "--reset-password"],
      { TEACHER_PASSWORD: TEST_PW }
    )
    expect(result.ok && result.options.resetPassword).toBe(true)
  })
})
