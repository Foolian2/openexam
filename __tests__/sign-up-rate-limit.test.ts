import { describe, expect, it } from "vitest"

import { signUpPerIpMax } from "@/lib/sign-up-rate-limit"

describe("signUpPerIpMax", () => {
  it("is 40 by default", () => {
    expect(signUpPerIpMax({})).toBe(40)
  })

  it("ignores the override outside CI", () => {
    expect(signUpPerIpMax({ SIGN_UP_RATE_LIMIT_MAX: "1000" })).toBe(40)
  })

  it("applies the override in CI", () => {
    expect(
      signUpPerIpMax({
        CI: "true",
        SIGN_UP_RATE_LIMIT_MAX: "1000",
      })
    ).toBe(1000)
  })

  it("ignores invalid overrides", () => {
    for (const value of ["0", "-5", "abc", "1.5", ""]) {
      expect(
        signUpPerIpMax({
          CI: "true",
          SIGN_UP_RATE_LIMIT_MAX: value,
        })
      ).toBe(40)
    }
  })
})
