import { describe, expect, it } from "vitest"
import {
  auditSearchParams,
  loadAuditSearchParams,
  serializeAuditSearchParams,
} from "@/lib/search-params/audit"
import { loadExamListSearchParams } from "@/lib/search-params/exam-list"
import { loadGradesSearchParams } from "@/lib/search-params/grades"
import { loadQuestionBankSearchParams } from "@/lib/search-params/question-bank"
import { loadUserManagementSearchParams } from "@/lib/search-params/user-management"

describe("parseAsPage (via createLoader)", () => {
  it.each([
    [{}, 1],
    [{ page: "abc" }, 1],
    [{ page: "" }, 1],
    [{ page: "0" }, 1],
    [{ page: "-5" }, 1],
    [{ page: "1" }, 1],
    [{ page: "7" }, 7],
  ])("clamps %o to %i", async (input, expected) => {
    const { page } = await loadGradesSearchParams(input)
    expect(page).toBe(expected)
  })
})

describe("loadAuditSearchParams", () => {
  it("applies defaults when params are missing", async () => {
    const result = await loadAuditSearchParams({})
    expect(result).toEqual({
      page: 1,
      examId: "",
      action: "",
      userId: "",
      from: "",
      to: "",
      ip: "",
    })
  })

  it("passes filter values through unchanged", async () => {
    const result = await loadAuditSearchParams({
      page: "3",
      from: "2026-01-01",
      to: "2026-01-31",
      ip: "10.0.0.1",
    })
    expect(result).toMatchObject({
      page: 3,
      from: "2026-01-01",
      to: "2026-01-31",
      ip: "10.0.0.1",
    })
  })
})

describe("serializeAuditSearchParams", () => {
  it("returns an empty string when everything is at its default", () => {
    expect(serializeAuditSearchParams({})).toBe("")
  })

  it("clears default values so export URLs stay minimal", () => {
    expect(
      serializeAuditSearchParams({ page: 1, examId: "e1", ip: "" })
    ).toBe("?examId=e1")
  })
})

describe("remaining loaders", () => {
  it("defaults q/status/folder to empty strings", async () => {
    expect(await loadExamListSearchParams({})).toEqual({
      page: 1,
      status: "",
      q: "",
      folder: "",
    })
    expect(await loadUserManagementSearchParams({})).toEqual({
      page: 1,
      q: "",
    })
  })

  it("keeps question-bank sort params as raw strings for server validation", async () => {
    const result = await loadQuestionBankSearchParams({
      sortBy: "title",
      sortDir: "asc",
      q: "  Algebra  ",
    })
    expect(result).toMatchObject({
      sortBy: "title",
      sortDir: "asc",
      q: "  Algebra  ",
    })
  })
})

describe("parser options", () => {
  it("every parser triggers a server round-trip with push history", () => {
    for (const parser of Object.values(auditSearchParams)) {
      expect(parser.shallow).toBe(false)
      expect(parser.history).toBe("push")
    }
  })
})
