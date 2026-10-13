import { describe, expect, it } from "vitest"
import {
  deriveSchoolRole,
  parseDomainList,
  schoolDomainsIssue,
} from "@/lib/school-domains"

const env = {
  SCHOOL_STUDENT_DOMAINS: "stud.example-school.ch",
  SCHOOL_TEACHER_DOMAINS: " Example-School.ch , @staff.example.org",
}

describe("parseDomainList", () => {
  it("trims, lowercases, strips a leading @ and drops empties", () => {
    expect(parseDomainList(" A.ch, ,@b.ch ")).toEqual(["a.ch", "b.ch"])
    expect(parseDomainList(undefined)).toEqual([])
  })
})

describe("deriveSchoolRole", () => {
  it("maps student and teacher domains", () => {
    expect(deriveSchoolRole("a.b@stud.example-school.ch", env)).toBe("STUDENT")
    expect(deriveSchoolRole("a.b@EXAMPLE-SCHOOL.CH", env)).toBe("TEACHER")
    expect(deriveSchoolRole("a@staff.example.org", env)).toBe("TEACHER")
  })

  it("matches domains exactly, not by suffix", () => {
    expect(deriveSchoolRole("a@evil-example-school.ch", env)).toBeNull()
    expect(deriveSchoolRole("a@sub.example-school.ch", env)).toBeNull()
  })

  it("returns null without configured domains", () => {
    expect(deriveSchoolRole("a@example-school.ch", {})).toBeNull()
    expect(deriveSchoolRole("no-at-sign", env)).toBeNull()
  })
})

describe("schoolDomainsIssue", () => {
  it("accepts valid lists", () => {
    expect(schoolDomainsIssue(env)).toBeNull()
    expect(schoolDomainsIssue({})).toBeNull()
  })

  it("rejects invalid domains and overlaps", () => {
    expect(
      schoolDomainsIssue({ SCHOOL_STUDENT_DOMAINS: "not a domain" })
    ).toMatch(/not a valid domain/)
    expect(
      schoolDomainsIssue({
        SCHOOL_STUDENT_DOMAINS: "a.ch",
        SCHOOL_TEACHER_DOMAINS: "a.ch",
      })
    ).toMatch(/both/)
  })
})
