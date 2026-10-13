import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The two student reads around a shared start: the full session state (with
// questions) and the waiting room's start poll.
const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  requireSession: vi.fn(),
  requireStudent: vi.fn(),
  limit: vi.fn(),
  guard: vi.fn(),
  answers: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
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
  m.requireSession.mockResolvedValue({
    user: { id: "student" },
    session: { id: "auth-1" },
  })
  m.requireStudent.mockResolvedValue({ user: { id: "student" } })
  m.limit.mockResolvedValue({ allowed: true })
  m.guard.mockResolvedValue({ ok: true })
  m.answers.mockResolvedValue([])
  m.updateMany.mockResolvedValue({ count: 1 })
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
