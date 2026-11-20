import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  publish: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: { findUnique: m.findUnique, updateMany: m.updateMany },
  },
}))
vi.mock("@/lib/redis", () => ({ redis: { publish: m.publish } }))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }))

import {
  claimExamDevice,
  getExamDeviceId,
  isActiveDevice,
} from "@/lib/exam-device"

const DEVICE = "11111111-1111-4111-8111-111111111111"
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222"
const claim = (authSessionId = "auth-new", deviceId = DEVICE) =>
  claimExamDevice({
    examSessionId: "sess-1",
    examId: "exam-1",
    userId: "student-1",
    authSessionId,
    deviceId,
    ip: "10.0.0.2",
    userAgent: "SEB",
  })

beforeEach(() => {
  vi.resetAllMocks()
  m.updateMany.mockResolvedValue({ count: 1 })
  m.publish.mockResolvedValue(1)
})

describe("isActiveDevice", () => {
  it("admits any login while unclaimed", () => {
    expect(
      isActiveDevice(
        { activeAuthSessionId: null, activeDeviceId: null },
        "auth-1"
      )
    ).toBe(true)
    expect(isActiveDevice({}, "auth-1")).toBe(true)
  })

  it("admits only the claiming login once claimed", () => {
    const claimed = { activeAuthSessionId: "auth-1" }
    expect(isActiveDevice(claimed, "auth-1")).toBe(true)
    expect(isActiveDevice(claimed, "auth-2")).toBe(false)
  })
})

describe("claimExamDevice", () => {
  it("claims an unclaimed session without flagging a takeover, but bumps the claim version", async () => {
    m.findUnique.mockResolvedValueOnce({
      activeAuthSessionId: null,
      activeDeviceId: null,
      deviceReplacedCount: 0,
      claimVersion: 0,
      status: "IN_PROGRESS",
    })

    expect(await claim()).toEqual({ replaced: false })
    expect(m.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sess-1",
        activeAuthSessionId: null,
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 0,
        status: { in: ["IN_PROGRESS", "LOCKED"] },
      },
      // claimVersion advances even on the initial binding, so a WS socket
      // that read the unclaimed row at version 0 cannot evict the owner.
      data: {
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        claimVersion: { increment: 1 },
      },
    })
    expect(m.audit).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
  })

  it("is a no-op for the login that already holds the session", async () => {
    m.findUnique.mockResolvedValueOnce({
      activeAuthSessionId: "auth-new",
      activeDeviceId: DEVICE,
      deviceReplacedCount: 0,
      claimVersion: 1,
      status: "IN_PROGRESS",
    })

    expect(await claim()).toEqual({ replaced: false })
    expect(m.updateMany).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("counts, audits and announces a takeover from another login", async () => {
    m.findUnique
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-old",
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 1,
        status: "IN_PROGRESS",
      })
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        deviceReplacedCount: 1,
        claimVersion: 2,
      })

    expect(await claim()).toEqual({ replaced: true, count: 1 })
    expect(m.updateMany).toHaveBeenCalledWith({
      where: {
        id: "sess-1",
        activeAuthSessionId: "auth-old",
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 1,
        status: { in: ["IN_PROGRESS", "LOCKED"] },
      },
      data: {
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        claimVersion: { increment: 1 },
        deviceReplacedCount: { increment: 1 },
        deviceReplacedAt: expect.any(Date),
      },
    })
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SESSION_DEVICE_REPLACED",
        entityId: "sess-1",
        examId: "exam-1",
        userId: "student-1",
        ipAddress: "10.0.0.2",
        metadata: { count: 1, loginChanged: true, tabChanged: true },
      })
    )
    expect(m.publish).toHaveBeenCalledWith(
      "exam:exam-1:control",
      JSON.stringify({
        type: "SESSION_REPLACED",
        sessionId: "sess-1",
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        deviceReplacedCount: 1,
        claimVersion: 2,
      })
    )
    expect(m.publish).toHaveBeenCalledWith(
      "exam:exam-1:monitor",
      JSON.stringify({
        originId: "web",
        sessionId: "sess-1",
        patch: { deviceReplacedCount: 1 },
      })
    )
  })

  it("re-reads and retries when a concurrent claim moved the value", async () => {
    m.findUnique
      .mockResolvedValueOnce({
        activeAuthSessionId: null,
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 0,
        status: "IN_PROGRESS",
      })
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-other",
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 1,
        status: "IN_PROGRESS",
      })
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        deviceReplacedCount: 1,
        claimVersion: 2,
      })
    m.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })

    expect(await claim()).toEqual({ replaced: true, count: 1 })
    expect(m.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          id: "sess-1",
          activeAuthSessionId: "auth-other",
          activeDeviceId: null,
          deviceReplacedCount: 0,
          claimVersion: 1,
          status: { in: ["IN_PROGRESS", "LOCKED"] },
        },
      })
    )
    expect(m.audit).toHaveBeenCalledTimes(1)
  })

  it("keeps the takeover when Redis is down", async () => {
    m.findUnique
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-old",
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 1,
        status: "IN_PROGRESS",
      })
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        deviceReplacedCount: 1,
        claimVersion: 2,
      })
    m.publish.mockRejectedValue(new Error("redis down"))

    expect(await claim()).toEqual({ replaced: true, count: 1 })
    expect(m.audit).toHaveBeenCalledTimes(1)
  })

  it("still publishes the takeover when the audit write fails", async () => {
    m.findUnique
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-old",
        activeDeviceId: null,
        deviceReplacedCount: 0,
        claimVersion: 1,
        status: "IN_PROGRESS",
      })
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        deviceReplacedCount: 1,
        claimVersion: 2,
      })
    m.audit.mockRejectedValue(new Error("audit db down"))

    // The claim is already committed; the audit failure must not surface as
    // a 500 or suppress the takeover notification.
    expect(await claim()).toEqual({ replaced: true, count: 1 })
    expect(m.publish).toHaveBeenCalledWith(
      "exam:exam-1:control",
      expect.stringContaining('"claimVersion":2')
    )
  })
})

describe("tab binding", () => {
  it("rejects another tab sharing the authentication cookie and missing identities", () => {
    const row = { activeAuthSessionId: "auth-new", activeDeviceId: DEVICE }
    expect(isActiveDevice(row, "auth-new", DEVICE)).toBe(true)
    expect(isActiveDevice(row, "auth-new", OTHER_DEVICE)).toBe(false)
    expect(isActiveDevice(row, "auth-new")).toBe(false)
    expect(isActiveDevice(row, "auth-other", DEVICE)).toBe(false)
  })

  it("counts a takeover by another tab of the same login", async () => {
    m.findUnique
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-new",
        activeDeviceId: OTHER_DEVICE,
        deviceReplacedCount: 0,
        claimVersion: 1,
        status: "IN_PROGRESS",
      })
      .mockResolvedValueOnce({
        activeAuthSessionId: "auth-new",
        activeDeviceId: DEVICE,
        deviceReplacedCount: 1,
        claimVersion: 2,
      })
    expect(await claim()).toEqual({ replaced: true, count: 1 })
    expect(m.audit).toHaveBeenCalledTimes(1)
  })

  it("binds a legacy login without falsely flagging a takeover", async () => {
    m.findUnique.mockResolvedValueOnce({
      activeAuthSessionId: "auth-new",
      activeDeviceId: null,
      deviceReplacedCount: 0,
      claimVersion: 1,
      status: "IN_PROGRESS",
    })
    expect(await claim()).toEqual({ replaced: false })
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ claimVersion: { increment: 1 } }),
      })
    )
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("reports failure when every claim loses the comparison", async () => {
    m.findUnique.mockResolvedValue({
      activeAuthSessionId: "auth-old",
      activeDeviceId: OTHER_DEVICE,
      deviceReplacedCount: 0,
      claimVersion: 4,
      status: "IN_PROGRESS",
    })
    m.updateMany.mockResolvedValue({ count: 0 })
    await expect(claim()).rejects.toMatchObject({
      status: 409,
      code: "SESSION_REPLACED",
    })
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("does not claim a session that closed while the request was in flight", async () => {
    m.findUnique.mockResolvedValue({
      activeAuthSessionId: "auth-new",
      activeDeviceId: DEVICE,
      deviceReplacedCount: 0,
      claimVersion: 1,
      status: "SUBMITTED",
    })
    await expect(claim()).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    })
    expect(m.updateMany).not.toHaveBeenCalled()
  })

  it("validates the device header", () => {
    expect(
      getExamDeviceId(new Headers({ "x-openexam-device-id": DEVICE }))
    ).toBe(DEVICE)
    expect(
      getExamDeviceId(new Headers({ "x-openexam-device-id": "arbitrary" }))
    ).toBeNull()
    // A non-v4 UUID is rejected too: client, REST and WS all require v4.
    expect(
      getExamDeviceId(
        new Headers({
          "x-openexam-device-id": "550e8400-e29b-11d4-a716-446655440000",
        })
      )
    ).toBeNull()
    expect(getExamDeviceId(new Headers())).toBeNull()
  })
})

it("suppresses a takeover notification superseded during the audit write", async () => {
  m.findUnique
    .mockResolvedValueOnce({
      activeAuthSessionId: "auth-old",
      activeDeviceId: OTHER_DEVICE,
      deviceReplacedCount: 3,
      claimVersion: 5,
      status: "IN_PROGRESS",
    })
    .mockResolvedValueOnce({
      activeAuthSessionId: "auth-latest",
      activeDeviceId: OTHER_DEVICE,
      deviceReplacedCount: 5,
      claimVersion: 7,
    })
  await expect(claim()).rejects.toMatchObject({ code: "SESSION_REPLACED" })
  expect(m.publish).not.toHaveBeenCalled()
  expect(m.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({ count: 4 }),
    })
  )
})

it("claims locked sessions without opening them for writes", async () => {
  m.findUnique.mockResolvedValueOnce({
    activeAuthSessionId: null,
    activeDeviceId: null,
    deviceReplacedCount: 0,
    claimVersion: 0,
    status: "LOCKED",
  })
  expect(await claim()).toEqual({ replaced: false })
})
