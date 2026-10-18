import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The two student reads around a shared start: the full session state (with
// questions) and the waiting room's start poll.
const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  queryRaw: vi.fn(),
  updateMany: vi.fn(),
  requireSession: vi.fn(),
  requireStudent: vi.fn(),
  limit: vi.fn(),
  guard: vi.fn(),
  answers: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: m.queryRaw,
    examSession: { findUnique: m.findUnique, updateMany: m.updateMany },
  },
}))
vi.mock("@/lib/api-auth", () => ({
  requireSession: m.requireSession,
  requireStudent: m.requireStudent,
}))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: m.limit }))
vi.mock("@/lib/seb-guard", () => ({ verifySebAccess: m.guard }))
vi.mock("@/lib/ws-answer-buffer", () => ({ loadSessionAnswers: m.answers }))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
vi.mock("@/lib/redis", () => ({ redis: { publish: m.publish } }))

const NOW = new Date("2030-01-01T10:00:00Z")
const params = { params: Promise.resolve({ id: "s1" }) }
const get = (path: string) => new NextRequest(`http://localhost${path}`)

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    userId: "student",
    status: "WAITING",
    startedAt: null,
    submittedAt: null,
    effectiveEndTime: null,
    timeExtensionMin: 0,
    lastSeenAt: null,
    bookmarks: [],
    exam: {
      id: "exam",
      status: "PUBLISHED",
      shuffleQuestions: false,
      shuffleOptions: false,
      questions: [
        {
          id: "q1",
          type: "FREE_TEXT",
          order: 0,
          title: "Secret question",
          points: 1,
          required: false,
          config: {},
        },
      ],
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
  m.requireSession.mockResolvedValue({ user: { id: "student" } })
  m.requireStudent.mockResolvedValue({ user: { id: "student" } })
  m.limit.mockResolvedValue({ allowed: true })
  m.guard.mockResolvedValue({ ok: true })
  m.answers.mockResolvedValue([])
  m.updateMany.mockResolvedValue({ count: 1 })
  m.publish.mockResolvedValue(1)
})

describe("GET /api/sessions/[id] before the shared start", () => {
  it("withholds the questions while waiting", async () => {
    m.findUnique.mockResolvedValue(sessionRow())
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_STARTED")
    expect(JSON.stringify(body)).not.toContain("Secret question")
  })

  it("withholds them during the countdown after Start", async () => {
    m.findUnique.mockResolvedValue(
      sessionRow({
        status: "IN_PROGRESS",
        startedAt: new Date(NOW.getTime() + 5_000),
        exam: { ...sessionRow().exam, status: "ACTIVE" },
      })
    )
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(409)
  })

  it("serves them once the shared start is reached", async () => {
    m.findUnique.mockResolvedValue(
      sessionRow({
        status: "IN_PROGRESS",
        startedAt: NOW,
        exam: { ...sessionRow().exam, status: "ACTIVE" },
      })
    )
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(200)
    expect((await res.json()).questions).toHaveLength(1)
  })
})

describe("GET /api/sessions/[id]/start-status", () => {
  it("reports the shared start with the server's clock", async () => {
    const startedAt = new Date(NOW.getTime() + 10_000)
    m.findUnique.mockResolvedValue(
      sessionRow({
        status: "IN_PROGRESS",
        startedAt,
        exam: { status: "ACTIVE" },
      })
    )
    const { GET } = await import("@/app/api/sessions/[id]/start-status/route")
    const res = await GET(get("/api/sessions/s1/start-status"), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "IN_PROGRESS",
      examStatus: "ACTIVE",
      startedAt: startedAt.toISOString(),
      serverNow: NOW.toISOString(),
    })
  })

  it("records presence in the room at most every 30 s", async () => {
    const { GET } = await import("@/app/api/sessions/[id]/start-status/route")
    m.findUnique.mockResolvedValue(
      sessionRow({
        lastSeenAt: new Date(NOW.getTime() - 10_000),
        exam: { status: "PUBLISHED" },
      })
    )
    await GET(get("/api/sessions/s1/start-status"), params)
    expect(m.updateMany).not.toHaveBeenCalled()

    m.findUnique.mockResolvedValue(
      sessionRow({
        lastSeenAt: new Date(NOW.getTime() - 31_000),
        exam: { status: "PUBLISHED" },
      })
    )
    await GET(get("/api/sessions/s1/start-status"), params)
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: "s1", status: "WAITING" },
      data: { lastSeenAt: NOW },
    })
  })

  it("answers 404 for another student's session", async () => {
    m.findUnique.mockResolvedValue(sessionRow({ userId: "someone-else" }))
    const { GET } = await import("@/app/api/sessions/[id]/start-status/route")
    const res = await GET(get("/api/sessions/s1/start-status"), params)
    expect(res.status).toBe(404)
  })
})

describe("SEB session clock", () => {
  function pending() {
    return sessionRow({
      status: "IN_PROGRESS",
      exam: {
        ...sessionRow().exam,
        status: "ACTIVE",
        sebRequired: true,
        timeLimitMin: 60,
      },
    })
  }

  it("does not start or expose questions when SEB verification fails", async () => {
    m.findUnique.mockResolvedValue(pending())
    m.guard.mockResolvedValue({ ok: false, reason: "missing_token" })
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(403)
    expect(m.queryRaw).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain("Secret question")
  })

  it("returns a fresh clock on the first verified SEB data load", async () => {
    m.findUnique.mockResolvedValue(pending())
    const deadline = new Date(NOW.getTime() + 60 * 60_000)
    m.queryRaw.mockResolvedValue([
      { ...pending(), startedAt: NOW, effectiveEndTime: deadline },
    ])
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.session.startedAt).toBe(NOW.toISOString())
    expect(body.session.effectiveEndTime).toBe(deadline.toISOString())
    expect(body.questions).toHaveLength(1)
    expect(m.queryRaw).toHaveBeenCalledOnce()
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "SESSION_STARTED", entityId: "s1" })
    )
    // Live monitors learn the winning clock without waiting for a poll.
    expect(m.publish).toHaveBeenCalledWith(
      "exam:exam:control",
      JSON.stringify({
        type: "SESSION_EXTENDED",
        sessionId: "s1",
        effectiveEndTime: deadline,
        timeExtensionMin: 0,
      })
    )
  })

  it("still serves the load if the monitor publish fails", async () => {
    m.findUnique.mockResolvedValue(pending())
    m.queryRaw.mockResolvedValue([{ ...pending(), startedAt: NOW }])
    m.publish.mockRejectedValue(new Error("redis down"))
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(200)
  })

  it("caps only the base duration at the schedule, then adds pending grants", async () => {
    m.findUnique.mockResolvedValue(pending())
    m.queryRaw.mockResolvedValue([{ ...pending(), startedAt: NOW }])
    const { GET } = await import("@/app/api/sessions/[id]/route")
    await GET(get("/api/sessions/s1"), params)
    const sql = m.queryRaw.mock.calls[0][0].join("?").replace(/\s+/g, " ")
    expect(sql).toContain(`END ) + s."timeExtensionMin" * interval '1 minute'`)
    expect(sql).not.toContain(`e."timeLimitMin" + s."timeExtensionMin"`)
  })

  it("uses the winning clock if another verified load starts concurrently", async () => {
    const winner = {
      ...pending(),
      startedAt: new Date(NOW.getTime() - 1000),
      effectiveEndTime: new Date(NOW.getTime() + 3599_000),
    }
    m.findUnique.mockResolvedValueOnce(pending()).mockResolvedValueOnce(winner)
    m.queryRaw.mockResolvedValue([])
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(200)
    expect((await res.json()).session.startedAt).toBe(
      winner.startedAt.toISOString()
    )
    // Only the load that set the clock records and publishes the start.
    expect(m.audit).not.toHaveBeenCalled()
    expect(m.publish).not.toHaveBeenCalled()
  })

  it("does not start or expose questions if the teacher locks during entry", async () => {
    m.findUnique
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce({ ...pending(), status: "LOCKED" })
    m.queryRaw.mockResolvedValue([])
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain("Secret question")
  })

  it("withholds questions from a reservation locked before first entry", async () => {
    m.findUnique.mockResolvedValue({ ...pending(), status: "LOCKED" })
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(403)
    expect(m.queryRaw).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain("Secret question")
  })

  it("still serves a locked SEB session whose clock already started", async () => {
    m.findUnique.mockResolvedValue({
      ...pending(),
      status: "LOCKED",
      startedAt: NOW,
      effectiveEndTime: new Date(NOW.getTime() + 60 * 60_000),
    })
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect(res.status).toBe(200)
  })

  it("preserves the deadline on reloads of an already started SEB exam", async () => {
    const deadline = new Date(NOW.getTime() + 90 * 60_000)
    m.findUnique.mockResolvedValue({
      ...pending(),
      startedAt: NOW,
      effectiveEndTime: deadline,
    })
    const { GET } = await import("@/app/api/sessions/[id]/route")
    const res = await GET(get("/api/sessions/s1"), params)
    expect((await res.json()).session.effectiveEndTime).toBe(
      deadline.toISOString()
    )
    expect(m.queryRaw).not.toHaveBeenCalled()
  })
})
