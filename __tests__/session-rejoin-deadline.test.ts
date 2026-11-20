import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  exam: { findUnique: vi.fn() },
  session: { findUnique: vi.fn() },
  transaction: vi.fn(),
  joinActive: vi.fn(),
  auth: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { exam: m.exam, examSession: m.session, $transaction: m.transaction },
}))
vi.mock("@/lib/join-active-exam", () => ({ joinActiveExam: m.joinActive }))
vi.mock("@/lib/api-auth", () => ({ requireStudent: m.auth }))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.limit }))
vi.mock("@/lib/exam-admission", () => ({
  reserveAdmission: vi.fn().mockResolvedValue({ waitMs: 0 }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ user: { id: "student" } })
  m.limit.mockResolvedValue({ allowed: true })
  m.exam.findUnique.mockResolvedValue({
    id: "exam",
    status: "ACTIVE",
    title: "x",
    timeLimitMin: 60,
    scheduledEnd: new Date("2030-01-01T10:10:00Z"),
    scheduledStart: null,
  })
})
it("rejoining preserves an already extended deadline, including concurrent extension", async () => {
  const original = {
    id: "session",
    status: "IN_PROGRESS",
    startedAt: new Date("2030-01-01T10:00:00Z"),
    effectiveEndTime: new Date("2030-01-01T10:40:00Z"),
    timeExtensionMin: 30,
  }
  m.session.findUnique.mockResolvedValue(original)
  const settled = {
    ...original,
    effectiveEndTime: new Date("2030-01-01T10:50:00Z"),
    timeExtensionMin: 40,
  }
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  m.transaction.mockImplementation(async (cb) =>
    cb({
      examSession: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue(settled),
      },
    })
  )
  const { POST } = await import("@/app/api/sessions/route")
  const res = await POST(
    new NextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      body: JSON.stringify({ accessCode: "ABCDEF" }),
    })
  )
  expect(res.status).toBe(200)
  expect(updateMany.mock.calls[0][0].data).not.toHaveProperty(
    "effectiveEndTime"
  )
})

it("refuses to join without a strict same-site Origin (CSRF)", async () => {
  const { POST } = await import("@/app/api/sessions/route")
  const res = await POST(
    new NextRequest("http://localhost/api/sessions", {
      method: "POST",
      body: JSON.stringify({ accessCode: "ABCDEF" }),
    })
  )
  expect(res.status).toBe(403)
})

it("starts a first join through the single-statement helper without an interactive transaction", async () => {
  m.session.findUnique.mockResolvedValue(null)
  m.joinActive.mockImplementation(async (create) => ({
    id: "session",
    ...create,
  }))
  expect((await join()).status).toBe(201)
  expect(m.transaction).not.toHaveBeenCalled()
  expect(m.joinActive).toHaveBeenCalledTimes(1)
  expect(m.joinActive.mock.calls[0][0]).toMatchObject({
    examId: "exam",
    userId: "student",
    status: "IN_PROGRESS",
  })
})
it("rejects first admission if close won the write race", async () => {
  m.session.findUnique.mockResolvedValue(null)
  m.joinActive.mockResolvedValue(null)
  expect((await join()).status).toBe(409)
})

async function join() {
  const { POST } = await import("@/app/api/sessions/route")
  return POST(
    new NextRequest("http://localhost/api/sessions", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      body: JSON.stringify({ accessCode: "ABCDEF" }),
    })
  )
}

it.each([false, true])(
  "first join defers the clock only when SEB is required (%s)",
  async (sebRequired) => {
    m.exam.findUnique.mockResolvedValue({
      ...(await m.exam.findUnique()),
      sebRequired,
    })
    m.session.findUnique.mockResolvedValue(null)
    m.joinActive.mockImplementation(async (create) => ({
      id: "session",
      ...create,
    }))
    expect((await join()).status).toBe(201)
    const create = m.joinActive.mock.calls[0][0]
    if (sebRequired) {
      expect(create.startedAt).toBeNull()
      expect(create.effectiveEndTime).toBeNull()
    } else {
      expect(create.startedAt).toBeInstanceOf(Date)
      expect(create.effectiveEndTime).toBeInstanceOf(Date)
    }
    // The SEB clock start logs SESSION_STARTED itself.
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: sebRequired ? "SESSION_RESERVED" : "SESSION_STARTED",
      })
    )
  }
)

it("rejoining before launching SEB leaves the clock unstarted", async () => {
  m.exam.findUnique.mockResolvedValue({
    ...(await m.exam.findUnique()),
    sebRequired: true,
  })
  const pending = {
    id: "session",
    status: "IN_PROGRESS",
    startedAt: null,
    effectiveEndTime: null,
  }
  m.session.findUnique.mockResolvedValue(pending)
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  m.transaction.mockImplementation(async (cb) =>
    cb({
      examSession: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue(pending),
      },
    })
  )
  expect((await join()).status).toBe(200)
  expect(updateMany.mock.calls[0][0].data).toEqual({
    lastSeenAt: expect.any(Date),
  })
})

it("rejects a pending rejoin whose status gate loses to a teacher lock", async () => {
  m.exam.findUnique.mockResolvedValue({
    ...(await m.exam.findUnique()),
    sebRequired: true,
  })
  m.session.findUnique.mockResolvedValue({
    id: "session",
    status: "IN_PROGRESS",
    startedAt: null,
    effectiveEndTime: null,
  })
  const findUniqueOrThrow = vi.fn()
  m.transaction.mockImplementation(async (cb) =>
    cb({
      examSession: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow,
      },
    })
  )
  expect((await join()).status).toBe(403)
  expect(findUniqueOrThrow).not.toHaveBeenCalled()
  expect(m.audit).not.toHaveBeenCalled()
})
