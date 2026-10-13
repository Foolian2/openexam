import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createMany: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { create: mocks.create, createMany: mocks.createMany },
  },
}))
vi.mock("@/lib/logger", () => ({ logError: mocks.logError }))
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

import { createAuditLog } from "@/lib/audit"

const event = {
  action: "SESSION_SUBMITTED",
  entityType: "ExamSession",
  entityId: "s1",
  userId: "u1",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({})
  mocks.createMany.mockResolvedValue({ count: 1 })
})

describe("createAuditLog idempotency", () => {
  it("writes keyed events with ON CONFLICT DO NOTHING so a retry is a no-op", async () => {
    await createAuditLog({ ...event, idempotencyKey: "SESSION_SUBMITTED:s1" })
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [{ ...event, idempotencyKey: "SESSION_SUBMITTED:s1" }],
      skipDuplicates: true,
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it("keeps the plain insert for unkeyed events", async () => {
    await createAuditLog(event)
    expect(mocks.create).toHaveBeenCalledWith({ data: event })
    expect(mocks.createMany).not.toHaveBeenCalled()
  })

  it("never throws when the keyed write fails", async () => {
    mocks.createMany.mockRejectedValue(new Error("db down"))
    await expect(
      createAuditLog({ ...event, idempotencyKey: "k" })
    ).resolves.toBeUndefined()
    expect(mocks.logError).toHaveBeenCalledOnce()
  })
})
