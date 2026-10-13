import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  AUTO_ARCHIVE_AGE_DAYS,
  isEligibleForAutoArchive,
  sweepAutoArchive,
} from "@/lib/auto-archive"

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date("2026-08-08T12:00:00Z")

describe("isEligibleForAutoArchive", () => {
  it("archives CLOSED exams older than 30 days", () => {
    const updatedAt = new Date(NOW.getTime() - 31 * DAY_MS)
    expect(isEligibleForAutoArchive("CLOSED", updatedAt, NOW)).toBe(true)
  })

  it("archives GRADED exams older than 30 days", () => {
    const updatedAt = new Date(NOW.getTime() - 30 * DAY_MS - 1)
    expect(isEligibleForAutoArchive("GRADED", updatedAt, NOW)).toBe(true)
  })

  it("does not archive exams updated within the last 30 days", () => {
    const updatedAt = new Date(NOW.getTime() - 29 * DAY_MS)
    expect(isEligibleForAutoArchive("CLOSED", updatedAt, NOW)).toBe(false)
  })

  it("treats exactly 30 days as not yet eligible", () => {
    const updatedAt = new Date(NOW.getTime() - AUTO_ARCHIVE_AGE_DAYS * DAY_MS)
    expect(isEligibleForAutoArchive("GRADED", updatedAt, NOW)).toBe(false)
  })

  it("never archives DRAFT, PUBLISHED, ACTIVE, or ARCHIVED exams", () => {
    const updatedAt = new Date(NOW.getTime() - 90 * DAY_MS)
    for (const status of [
      "DRAFT",
      "PUBLISHED",
      "ACTIVE",
      "ARCHIVED",
    ] as const) {
      expect(isEligibleForAutoArchive(status, updatedAt, NOW)).toBe(false)
    }
  })
})

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))

describe("sweepAutoArchive", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns 0 and touches nothing when no exams are eligible", async () => {
    prismaMock.exam.findMany.mockResolvedValue([])
    const count = await sweepAutoArchive("user-1", NOW)
    expect(count).toBe(0)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled()
  })

  it("archives CLOSED and GRADED exams with the correct previous status", async () => {
    prismaMock.exam.findMany.mockResolvedValue([
      { id: "exam-closed", status: "CLOSED" },
      { id: "exam-graded", status: "GRADED" },
      { id: "exam-closed-2", status: "CLOSED" },
    ])
    prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })

    const count = await sweepAutoArchive("user-1", NOW)

    expect(count).toBe(3)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledTimes(3)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith({
      where: { id: "exam-closed", status: "CLOSED" },
      data: expect.objectContaining({
        status: "ARCHIVED",
        statusBeforeArchive: "CLOSED",
      }),
    })
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith({
      where: { id: "exam-graded", status: "GRADED" },
      data: expect.objectContaining({
        status: "ARCHIVED",
        statusBeforeArchive: "GRADED",
      }),
    })
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith({
      where: { id: "exam-closed-2", status: "CLOSED" },
      data: expect.objectContaining({
        status: "ARCHIVED",
        statusBeforeArchive: "CLOSED",
      }),
    })
  })

  it("writes an audit log entry for every archived exam", async () => {
    prismaMock.exam.findMany.mockResolvedValue([
      { id: "exam-closed", status: "CLOSED" },
    ])
    prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
    await sweepAutoArchive("user-1", NOW)
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "EXAM_ARCHIVED",
          entityId: "exam-closed",
          examId: "exam-closed",
          userId: "user-1",
        }),
      })
    )
  })

  it("does not log or count an exam whose status changed before the write landed", async () => {
    prismaMock.exam.findMany.mockResolvedValue([
      { id: "exam-stale", status: "CLOSED" },
      { id: "exam-race", status: "CLOSED" },
    ])
    // Simulate exam-race having moved off CLOSED between findMany and the
    // per-exam updateMany (its `where: { status: "CLOSED" }` now matches
    // nothing), while exam-stale updates normally.
    prismaMock.exam.updateMany.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve({ count: where.id === "exam-race" ? 0 : 1 })
    )

    const count = await sweepAutoArchive("user-1", NOW)

    expect(count).toBe(1)
    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entityId: "exam-stale" }),
      })
    )
  })
})
