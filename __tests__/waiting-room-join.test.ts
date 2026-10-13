import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// POST /api/sessions for a shared-start exam: the waiting room before Start,
// an ordinary late join after it, and the race between the two.
const m = vi.hoisted(() => ({
  exam: { findUnique: vi.fn() },
  session: { findUnique: vi.fn() },
  transaction: vi.fn(),
  auth: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
  admission: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { exam: m.exam, examSession: m.session, $transaction: m.transaction },
}))
vi.mock("@/lib/api-auth", () => ({ requireStudent: m.auth }))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.limit }))
vi.mock("@/lib/exam-admission", () => ({ reserveAdmission: m.admission }))

const opening = new Date("2030-01-01T10:00:00Z")

function examRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "exam",
    status: "PUBLISHED",
    waitingRoom: true,
    title: "Mathe",
    timeLimitMin: 60,
    sebRequired: false,
    scheduledStart: opening,
    // Stored from before the switch; a shared-start exam ignores it.
    scheduledEnd: new Date("2030-01-01T10:30:00Z"),
    ...overrides,
  }
}

function join() {
  return new NextRequest("http://localhost/api/sessions", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: JSON.stringify({ accessCode: "ABCDEF" }),
  })
}

/** A transaction whose exam row (read FOR SHARE) has `lockedStatus`. */
function txWith(lockedStatus: string, waitingRoom = true) {
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([{ status: lockedStatus, waitingRoom }]),
    examSession: {
      upsert: vi.fn(async (args) => ({ id: "s1", ...args.create })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn(),
    },
  }
  m.transaction.mockImplementation(async (cb) => cb(tx))
  return tx
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2030-01-01T11:00:00Z"))
  m.auth.mockResolvedValue({ user: { id: "student" } })
  m.limit.mockResolvedValue({ allowed: true })
  m.admission.mockResolvedValue({ waitMs: 0 })
  m.session.findUnique.mockResolvedValue(null)
  m.exam.findUnique.mockResolvedValue(examRow())
})

describe("waiting room join", () => {
  it("puts a first join into the waiting room without a clock", async () => {
    const tx = txWith("PUBLISHED")
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ examId: "exam", waiting: true })
    const create = tx.examSession.upsert.mock.calls[0][0].create
    expect(create.status).toBe("WAITING")
    expect(create).not.toHaveProperty("startedAt")
    expect(create).not.toHaveProperty("effectiveEndTime")
    // Read with a share lock so it cannot interleave with Start's FOR UPDATE.
    expect(tx.$queryRaw.mock.calls[0][0].join("")).toContain("FOR SHARE")
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SESSION_WAITING" })
    )
  })

  it("answers NOT_STARTED with the opening time before the room opens", async () => {
    vi.setSystemTime(new Date("2030-01-01T09:00:00Z"))
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_STARTED")
    // 10:00 UTC is 11:00 in Zurich (CET).
    expect(body.error.message).toContain("11:00")
    expect(m.transaction).not.toHaveBeenCalled()
  })

  it("does not reveal a published exam without the waiting room", async () => {
    m.exam.findUnique.mockResolvedValue(examRow({ waitingRoom: false }))
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(404)
  })

  it("re-entering keeps the same waiting session and writes no audit row", async () => {
    m.session.findUnique.mockResolvedValue({
      id: "s1",
      status: "WAITING",
      startedAt: null,
      timeExtensionMin: 0,
    })
    const tx = txWith("PUBLISHED")
    tx.examSession.upsert.mockResolvedValue({ id: "s1", status: "WAITING" })
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ sessionId: "s1", waiting: true })
    expect(m.admission).not.toHaveBeenCalled()
    expect(m.audit).not.toHaveBeenCalled()
  })

  it("refuses the join when the room was switched off meanwhile", async () => {
    const tx = txWith("PUBLISHED", false)
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(404)
    expect(tx.examSession.upsert).not.toHaveBeenCalled()
  })

  it("turns into a late join with the full time when Start won the race", async () => {
    const tx = txWith("ACTIVE")
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ waiting: false })
    const create = tx.examSession.upsert.mock.calls[0][0].create
    expect(create.status).toBe("IN_PROGRESS")
    expect(create.effectiveEndTime).toEqual(new Date("2030-01-01T12:00:00Z"))
  })
})

describe("late join after Start", () => {
  it("gets the full time limit from the join, not capped at scheduledEnd", async () => {
    m.exam.findUnique.mockResolvedValue(examRow({ status: "ACTIVE" }))
    const tx = txWith("ACTIVE")
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(201)
    const create = tx.examSession.upsert.mock.calls[0][0].create
    expect(create.status).toBe("IN_PROGRESS")
    // 11:00 + 60 min, although the stale scheduledEnd says 10:30.
    expect(create.effectiveEndTime).toEqual(new Date("2030-01-01T12:00:00Z"))
  })

  it("starts a session still WAITING under an ACTIVE exam as a late join", async () => {
    m.exam.findUnique.mockResolvedValue(examRow({ status: "ACTIVE" }))
    m.session.findUnique.mockResolvedValue({
      id: "s1",
      status: "WAITING",
      startedAt: null,
      timeExtensionMin: 9,
    })
    const tx = txWith("ACTIVE")
    tx.examSession.findUniqueOrThrow.mockResolvedValue({ id: "s1" })
    const { POST } = await import("@/app/api/sessions/route")
    const res = await POST(join())
    expect(res.status).toBe(200)
    const update = tx.examSession.updateMany.mock.calls[0][0]
    expect(update.where).toEqual({ id: "s1", status: "WAITING" })
    expect(update.data.status).toBe("IN_PROGRESS")
    expect(update.data.effectiveEndTime).toEqual(
      new Date("2030-01-01T12:09:00Z")
    )
  })
})
