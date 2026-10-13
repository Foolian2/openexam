import { describe, expect, it } from "vitest"
import {
  changeEmailSchema,
  changePasswordSchema,
  updateProfileSchema,
  updateUserRoleSchema,
} from "@/lib/validators/settings"

describe("updateProfileSchema", () => {
  it("accepts a valid name", () => {
    expect(updateProfileSchema.safeParse({ name: "Max Muster" }).success).toBe(true)
  })

  it("rejects names shorter than 2 characters", () => {
    const result = updateProfileSchema.safeParse({ name: "M" })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("Name muss mindestens 2 Zeichen haben")
  })

  it("rejects names longer than 100 characters", () => {
    expect(updateProfileSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false)
  })
})

describe("changeEmailSchema", () => {
  it("accepts a valid email address", () => {
    expect(changeEmailSchema.safeParse({ email: "max@muster.ch" }).success).toBe(true)
  })

  it("rejects an invalid email address", () => {
    const result = changeEmailSchema.safeParse({ email: "keine-email" })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("Ungültige E-Mail-Adresse")
  })
})

describe("changePasswordSchema", () => {
  const valid = {
    currentPassword: "alt-geheim",
    newPassword: "neu-geheim-1",
    confirmPassword: "neu-geheim-1",
  }

  it("accepts a valid payload", () => {
    expect(changePasswordSchema.safeParse(valid).success).toBe(true)
  })

  it("requires the current password", () => {
    expect(
      changePasswordSchema.safeParse({ ...valid, currentPassword: "" }).success
    ).toBe(false)
  })

  it("enforces the 8 character minimum on the new password", () => {
    const result = changePasswordSchema.safeParse({
      ...valid,
      newPassword: "kurz",
      confirmPassword: "kurz",
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("Passwort muss mindestens 8 Zeichen haben")
  })

  it("enforces the 128 character maximum on the new password", () => {
    const long = "x".repeat(129)
    expect(
      changePasswordSchema.safeParse({ ...valid, newPassword: long, confirmPassword: long })
        .success
    ).toBe(false)
  })

  it("rejects a mismatched confirmation", () => {
    const result = changePasswordSchema.safeParse({ ...valid, confirmPassword: "anders" })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe("Passwörter stimmen nicht überein")
    expect(result.error?.issues[0].path).toEqual(["confirmPassword"])
  })
})

describe("updateUserRoleSchema", () => {
  it("accepts every valid role", () => {
    for (const role of ["STUDENT", "TEACHER", "ADMIN"]) {
      expect(updateUserRoleSchema.safeParse({ role }).success).toBe(true)
    }
  })

  it("rejects unknown roles", () => {
    expect(updateUserRoleSchema.safeParse({ role: "SUPERADMIN" }).success).toBe(false)
    expect(updateUserRoleSchema.safeParse({ role: "student" }).success).toBe(false)
    expect(updateUserRoleSchema.safeParse({}).success).toBe(false)
  })
})
