import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn() },
    examSession: { findMany: vi.fn() },
    integrityEvent: { groupBy: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
}))
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
import { GET } from "@/app/api/exams/[id]/sessions/route"

function get() {
  return GET(new NextRequest("https://localhost/api/exams/exam1/sessions"), {
    params: Promise.resolve({ id: "exam1" }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  prismaMock.exam.findUnique.mockResolvedValue({
    id: "exam1",
    creatorId: "teacher1",
    _count: { questions: 2 },
  })
  prismaMock.examSession.findMany.mockResolvedValue([
    {
      id: "s1",
      user: { id: "u1" },
      _count: { answers: 1, integrityEvents: 1 },
      sebIntegrityFlaggedAt: null,
    },
    {
      id: "s2",
      user: { id: "u2" },
      _count: { answers: 0, integrityEvents: 0 },
      sebIntegrityFlaggedAt: null,
    },
  ])
  prismaMock.integrityEvent.groupBy.mockResolvedValue([
    { sessionId: "s1", _count: 2 },
  ])
})

describe("exam session monitor counts", () => {
  it("returns separate actionable and informational counts, including zero", async () => {
    const response = await get()
    expect(response.status).toBe(200)
    const { sessions } = await response.json()
    expect(sessions).toEqual([
      expect.objectContaining({
        id: "s1",
        integrityEventCount: 1,
        focusLossEventCount: 2,
      }),
      expect.objectContaining({
        id: "s2",
        integrityEventCount: 0,
        focusLossEventCount: 0,
      }),
    ])
    expect(prismaMock.examSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { examId: "exam1" },
        select: expect.objectContaining({
          _count: {
            select: {
              answers: true,
              integrityEvents: { where: { kind: { not: "PAGE_FOCUS_LOST" } } },
            },
          },
        }),
      })
    )
    expect(prismaMock.integrityEvent.groupBy).toHaveBeenCalledWith({
      by: ["sessionId"],
      where: { session: { examId: "exam1" }, kind: "PAGE_FOCUS_LOST" },
      _count: true,
    })
  })

  it("does not query event counts for another teacher's exam", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({ creatorId: "other" })
    expect((await get()).status).toBe(404)
    expect(prismaMock.integrityEvent.groupBy).not.toHaveBeenCalled()
  })
})
