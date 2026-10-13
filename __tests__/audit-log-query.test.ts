import { describe, expect, it, vi } from "vitest"

// buildAuditLogWhere is pure, but the module also exports fetchAuditLogPage,
// which imports @/lib/prisma — and that reads DATABASE_URL at import time.
// Mock it so this test doesn't need a real database just to import a pure
// function.
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

const { buildAuditLogWhere, buildAdminAuditLogWhere } =
  await import("@/lib/audit-log-query")

describe("buildAuditLogWhere", () => {
  it("scopes to exam-associated rows the caller owns, excluding non-exam rows", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1" })
    expect(where).toMatchObject({
      examId: { not: null },
      exam: { creatorId: "teacher1" },
    })
  })

  it("never lets one teacher's filter leak into another teacher's rows — creatorId always tracks the caller", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher2", examId: "exam1" })
    expect(where.exam).toEqual({ creatorId: "teacher2" })
    expect(where.examId).toBe("exam1")
  })

  it("filters by action when provided", () => {
    const where = buildAuditLogWhere({
      teacherId: "teacher1",
      action: "EXAM_PUBLISHED",
    })
    expect(where.action).toBe("EXAM_PUBLISHED")
  })

  it("omits the action clause when not provided", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1" })
    expect(where).not.toHaveProperty("action")
  })

  it("covers whole Swiss calendar days, including the 'to' day", () => {
    const where = buildAuditLogWhere({
      teacherId: "teacher1",
      from: "2026-01-01",
      to: "2026-01-31",
    })
    // CET (UTC+1): days start at 23:00 UTC the evening before.
    expect(where.timestamp).toEqual({
      gte: new Date("2025-12-31T23:00:00Z"),
      lt: new Date("2026-01-31T23:00:00Z"),
    })
  })

  it("uses CEST day bounds in summer", () => {
    const where = buildAuditLogWhere({
      teacherId: "teacher1",
      from: "2026-10-07",
      to: "2026-10-07",
    })
    expect(where.timestamp).toEqual({
      gte: new Date("2026-10-06T22:00:00Z"),
      lt: new Date("2026-10-07T22:00:00Z"),
    })
  })

  it("keeps full timestamps from API callers as exact bounds", () => {
    const where = buildAuditLogWhere({
      teacherId: "teacher1",
      from: "2026-10-07T08:00:00Z",
      to: "2026-10-07T09:00:00Z",
    })
    expect(where.timestamp).toEqual({
      gte: new Date("2026-10-07T08:00:00Z"),
      lte: new Date("2026-10-07T09:00:00Z"),
    })
  })

  it("ignores invalid date strings rather than producing an Invalid Date filter", () => {
    const where = buildAuditLogWhere({
      teacherId: "teacher1",
      from: "not-a-date",
    })
    expect(where).not.toHaveProperty("timestamp")
  })

  it("omits the timestamp clause entirely when neither from nor to is given", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1" })
    expect(where).not.toHaveProperty("timestamp")
  })

  it("filters by actor userId when provided", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1", userId: "user9" })
    expect(where.userId).toBe("user9")
  })

  it("omits the userId clause when not provided", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1" })
    expect(where).not.toHaveProperty("userId")
  })

  it("filters by case-insensitive partial IP match, trimmed", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1", ip: " 10.0.0. " })
    expect(where.ipAddress).toEqual({
      contains: "10.0.0.",
      mode: "insensitive",
    })
  })

  it("omits the ipAddress clause when ip is empty or whitespace", () => {
    const where = buildAuditLogWhere({ teacherId: "teacher1", ip: "   " })
    expect(where).not.toHaveProperty("ipAddress")
  })

  it("keeps the exam-scoped base clause even when actor/IP filters are combined", () => {
    const where = buildAuditLogWhere({
      teacherId: "teacher1",
      userId: "user9",
      ip: "10.0.0.1",
    })
    expect(where.exam).toEqual({ creatorId: "teacher1" })
    expect(where.userId).toBe("user9")
    expect(where.ipAddress).toEqual({
      contains: "10.0.0.1",
      mode: "insensitive",
    })
  })
})

describe("buildAdminAuditLogWhere", () => {
  it("has no owner scoping — admins see every row", () => {
    const where = buildAdminAuditLogWhere({})
    expect(where).toEqual({})
  })

  it("applies the same action/date/actor/IP filters", () => {
    const where = buildAdminAuditLogWhere({
      action: "TEACHER_PROMOTE_SUCCESS",
      userId: "user9",
      ip: "10.0.0.1",
      from: "2026-01-01",
    })
    expect(where).toMatchObject({
      action: "TEACHER_PROMOTE_SUCCESS",
      userId: "user9",
      ipAddress: { contains: "10.0.0.1", mode: "insensitive" },
    })
    expect(where.timestamp).toMatchObject({
      gte: new Date("2025-12-31T23:00:00Z"),
    })
  })

  it("surfaces non-exam actions the teacher view deliberately hides", () => {
    const where = buildAdminAuditLogWhere({ action: "USER_ROLE_CHANGED" })
    expect(where.action).toBe("USER_ROLE_CHANGED")
    expect(where).not.toHaveProperty("examId")
    expect(where).not.toHaveProperty("exam")
  })
})
