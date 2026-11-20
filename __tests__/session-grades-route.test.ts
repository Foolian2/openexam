import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock } = vi.hoisted(() => ({
  prismaMock: {
    examSession: { findUnique: vi.fn() },
    grade: { upsert: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  authMock: { api: { getSession: vi.fn() } },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))

import { PUT } from "@/app/api/sessions/[id]/grades/route"

const SESSION_ID = "c000000000000000000000001"
const Q_MC = "c000000000000000000000011"
const Q_TEXT = "c000000000000000000000012"

function call(grades: unknown[]) {
  const request = new NextRequest(
    `http://localhost:3000/api/sessions/${SESSION_ID}/grades`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grades }),
    }
  )
  return PUT(request, { params: Promise.resolve({ id: SESSION_ID }) })
}

/** questionIds passed to grade.upsert, i.e. the rows actually written. */
function written() {
  return prismaMock.grade.upsert.mock.calls.map(
    (c) => c[0].where.sessionId_questionId.questionId
  )
}

function submittedSession(grades: unknown[]) {
  return {
    id: SESSION_ID,
    examId: "exam1",
    status: "SUBMITTED",
    exam: {
      creatorId: "teacher1",
      questions: [
        { id: Q_MC, points: 2 },
        { id: Q_TEXT, points: 6 },
      ],
    },
    grades,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  prismaMock.examSession.findUnique.mockResolvedValue(
    submittedSession([
      { questionId: Q_MC, points: 0, feedback: null, autoGraded: true },
    ])
  )
  prismaMock.grade.upsert.mockImplementation((args) => args)
  prismaMock.grade.findMany.mockResolvedValue([])
  prismaMock.$transaction.mockResolvedValue([])
})

describe("PUT /api/sessions/[id]/grades", () => {
  it("leaves an untouched auto-graded row auto-graded", async () => {
    // The grader sends every row on the page; only the free-text one changed.
    const res = await call([
      { questionId: Q_MC, points: 0 },
      { questionId: Q_TEXT, points: 3, feedback: "ok" },
    ])
    expect(res.status).toBe(200)
    expect(written()).toEqual([Q_TEXT])
  })

  it("turns an auto-graded row manual once its points are overridden", async () => {
    await call([{ questionId: Q_MC, points: 2 }])
    expect(written()).toEqual([Q_MC])
    expect(prismaMock.grade.upsert.mock.calls[0][0].update.autoGraded).toBe(
      false
    )
  })

  it("counts added feedback as a change", async () => {
    await call([{ questionId: Q_MC, points: 0, feedback: "Lies genau." }])
    expect(written()).toEqual([Q_MC])
  })

  it("treats empty feedback the same as none", async () => {
    await call([{ questionId: Q_MC, points: 0, feedback: "" }])
    expect(written()).toEqual([])
  })

  it("writes the row when stored feedback 0 is cleared to empty", async () => {
    // "" is a meaningful clear value and "0" is a legitimate string; both
    // must survive the changed-row comparison.
    prismaMock.examSession.findUnique.mockResolvedValue(
      submittedSession([
        { questionId: Q_MC, points: 0, feedback: "0", autoGraded: true },
      ])
    )
    await call([{ questionId: Q_MC, points: 0, feedback: "" }])
    expect(written()).toEqual([Q_MC])
    expect(prismaMock.grade.upsert.mock.calls[0][0].update.feedback).toBe("")
  })

  it("writes the row when feedback is set to the string 0 on an empty row", async () => {
    await call([{ questionId: Q_MC, points: 0, feedback: "0" }])
    expect(written()).toEqual([Q_MC])
    expect(prismaMock.grade.upsert.mock.calls[0][0].update.feedback).toBe("0")
  })

  it("rewrites an existing manual grade even when unchanged", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue(
      submittedSession([
        { questionId: Q_MC, points: 1, feedback: null, autoGraded: false },
      ])
    )
    await call([{ questionId: Q_MC, points: 1 }])
    expect(written()).toEqual([Q_MC])
  })
})
