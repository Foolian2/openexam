import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, gradeSessionsMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn() },
    examSession: { findMany: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
  gradeSessionsMock: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/finalize-session", () => ({ gradeSessions: gradeSessionsMock }))

import { POST } from "@/app/api/exams/[id]/ensure-graded/route"

const EXAM_ID = "c000000000000000000000001"
const SESSION_ID = "c000000000000000000000002"

function call(body?: unknown) {
  const request = new NextRequest(
    `http://localhost:3000/api/exams/${EXAM_ID}/ensure-graded`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  )
  return POST(request, { params: Promise.resolve({ id: EXAM_ID }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  prismaMock.exam.findUnique.mockResolvedValue({
    creatorId: "teacher1",
    _count: { questions: 3 },
  })
  prismaMock.examSession.findMany.mockResolvedValue([])
  gradeSessionsMock.mockResolvedValue(undefined)
})

describe("POST /api/exams/[id]/ensure-graded", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    expect((await call()).status).toBe(401)
  })

  it("rejects students", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", role: "STUDENT" },
    })
    expect((await call()).status).toBe(403)
  })

  it("answers 404 for another teacher's exam and grades nothing", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      creatorId: "someone-else",
      _count: { questions: 3 },
    })
    const res = await call()
    expect(res.status).toBe(404)
    expect(gradeSessionsMock).not.toHaveBeenCalled()
  })

  it("grades submitted sessions with no grades or flagged needsRegrade", async () => {
    prismaMock.examSession.findMany.mockResolvedValue([
      { id: "s1" },
      { id: "s2" },
    ])
    const res = await call()
    expect(await res.json()).toEqual({ graded: 2 })
    expect(prismaMock.examSession.findMany.mock.calls[0][0].where).toEqual({
      examId: EXAM_ID,
      status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
      OR: [{ grades: { none: {} } }, { needsRegrade: true }],
    })
    expect(gradeSessionsMock).toHaveBeenCalledWith(["s1", "s2"])
  })

  it("narrows to one session when sessionId is given", async () => {
    await call({ sessionId: SESSION_ID })
    expect(
      prismaMock.examSession.findMany.mock.calls[0][0].where
    ).toMatchObject({ id: SESSION_ID })
  })

  it("does nothing when every session already has grades", async () => {
    const res = await call()
    expect(await res.json()).toEqual({ graded: 0 })
    expect(gradeSessionsMock).not.toHaveBeenCalled()
  })

  it("skips exams without questions", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      creatorId: "teacher1",
      _count: { questions: 0 },
    })
    expect(await (await call()).json()).toEqual({ graded: 0 })
    expect(prismaMock.examSession.findMany).not.toHaveBeenCalled()
  })

  it("rejects a malformed sessionId", async () => {
    expect((await call({ sessionId: "not-a-cuid" })).status).toBe(422)
  })
})
