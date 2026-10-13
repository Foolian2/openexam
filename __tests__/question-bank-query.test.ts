import { describe, expect, it, vi } from "vitest"

// buildQuestionBankWhere is pure, but the module also exports
// fetchQuestionBankPage, which imports @/lib/prisma — and that reads
// DATABASE_URL at import time. Mock it so this test doesn't need a real
// database just to import a pure function.
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

const { buildQuestionBankWhere, buildQuestionBankOrderBy } =
  await import("@/lib/question-bank-query")

describe("buildQuestionBankWhere", () => {
  it("always scopes to the caller — never lets one teacher see another's bank items", () => {
    const where = buildQuestionBankWhere({ creatorId: "teacher1" })
    expect(where.creatorId).toBe("teacher1")
  })

  it("filters by type when provided", () => {
    const where = buildQuestionBankWhere({
      creatorId: "teacher1",
      type: "SHORT_ANSWER",
    })
    expect(where.type).toBe("SHORT_ANSWER")
  })

  it("omits the type clause when not provided", () => {
    const where = buildQuestionBankWhere({ creatorId: "teacher1" })
    expect(where).not.toHaveProperty("type")
  })

  it("filters by folderId when provided", () => {
    const where = buildQuestionBankWhere({
      creatorId: "teacher1",
      folderId: "folder1",
    })
    expect(where.folderId).toBe("folder1")
  })

  it("does a case-insensitive title search, trimmed", () => {
    const where = buildQuestionBankWhere({
      creatorId: "teacher1",
      q: "  Bern  ",
    })
    expect(where.title).toEqual({ contains: "Bern", mode: "insensitive" })
  })

  it("omits the title clause when q is empty or whitespace-only", () => {
    const where = buildQuestionBankWhere({ creatorId: "teacher1", q: "   " })
    expect(where).not.toHaveProperty("title")
  })
})

describe("buildQuestionBankOrderBy", () => {
  it("defaults to updatedAt desc", () => {
    expect(buildQuestionBankOrderBy()).toEqual({ updatedAt: "desc" })
  })

  it("maps a whitelisted field and direction", () => {
    expect(buildQuestionBankOrderBy("title", "asc")).toEqual({
      title: "asc",
    })
    expect(buildQuestionBankOrderBy("points", "desc")).toEqual({
      points: "desc",
    })
  })

  it("falls back to the default for unknown fields or directions", () => {
    expect(buildQuestionBankOrderBy("config" as never, "desc")).toEqual({
      updatedAt: "desc",
    })
    expect(buildQuestionBankOrderBy("title", "sideways" as never)).toEqual({
      title: "desc",
    })
  })
})
