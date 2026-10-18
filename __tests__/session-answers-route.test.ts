import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, txMock, authMock, rateLimitMock, sebGuardMock } =
  vi.hoisted(() => {
    const txMock = {
      examSession: { updateMany: vi.fn() },
      $queryRaw: vi.fn(),
      answer: { findUniqueOrThrow: vi.fn() },
    }
    return {
      txMock,
      prismaMock: {
        examSession: { findUnique: vi.fn() },
        question: { findUnique: vi.fn() },
        $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) =>
          fn(txMock)
        ),
      },
      authMock: { api: { getSession: vi.fn() } },
      rateLimitMock: vi.fn(),
      sebGuardMock: vi.fn(),
    }
  })

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rateLimitMock }))
vi.mock("@/lib/seb-guard", () => ({ verifySebAccess: sebGuardMock }))
vi.mock("@/lib/seb-urls", () => ({
  publicRequestUrl: () => "https://localhost/answers",
}))

import { PUT } from "@/app/api/sessions/[id]/answers/route"

const SESSION_ID = "c000000000000000000000001"
const EXAM_ID = "c000000000000000000000002"
const QUESTION_ID = "c000000000000000000000003"
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
const SAVED_AT = new Date("2026-10-08T10:00:00Z")

const freeText = { type: "FREE_TEXT", text: "Antwort" }

function put(body: unknown) {
  return PUT(
    new NextRequest(`https://localhost/api/sessions/${SESSION_ID}/answers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SESSION_ID }) }
  )
}

function save(content: unknown = freeText, clientSeq?: number) {
  return put({ questionId: QUESTION_ID, content, clientSeq })
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "student1", role: "STUDENT" },
  })
  rateLimitMock.mockResolvedValue({ allowed: true })
  sebGuardMock.mockResolvedValue({ ok: true })
  prismaMock.examSession.findUnique.mockResolvedValue({
    id: SESSION_ID,
    examId: EXAM_ID,
    userId: "student1",
    status: "IN_PROGRESS",
    startedAt: new Date("2026-10-08T09:00:00Z"),
    effectiveEndTime: null,
    exam: { id: EXAM_ID, requireSeb: false },
  })
  prismaMock.question.findUnique.mockResolvedValue({
    id: QUESTION_ID,
    examId: EXAM_ID,
    type: "FREE_TEXT",
  })
  txMock.examSession.updateMany.mockResolvedValue({ count: 1 })
  txMock.$queryRaw.mockResolvedValue([{ version: 3, updatedAt: SAVED_AT }])
})

function expectNothingWritten() {
  expect(prismaMock.$transaction).not.toHaveBeenCalled()
}

describe("PUT /api/sessions/[id]/answers: access", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    expect((await save()).status).toBe(401)
    expectNothingWritten()
  })

  it("answers 429 once the autosave budget is used up", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, resetInSeconds: 30 })
    expect((await save()).status).toBe(429)
    expectNothingWritten()
  })

  it("hides a missing session as 404", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue(null)
    expect((await save()).status).toBe(404)
  })

  it("refuses to write into another student's session", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      examId: EXAM_ID,
      userId: "student2",
      status: "IN_PROGRESS",
      effectiveEndTime: null,
      exam: { id: EXAM_ID },
    })
    expect((await save()).status).toBe(404)
    expectNothingWritten()
  })

  it("refuses the save when the SEB guard fails", async () => {
    sebGuardMock.mockResolvedValue({ ok: false })
    expect((await save()).status).toBe(403)
    expectNothingWritten()
  })

  it("refuses the save after the deadline and its grace window", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      examId: EXAM_ID,
      userId: "student1",
      status: "IN_PROGRESS",
      effectiveEndTime: new Date(Date.now() - 5 * 60_000),
      exam: { id: EXAM_ID },
    })
    expect((await save()).status).toBe(409)
    expectNothingWritten()
  })

  it("refuses the save before an SEB session's clock has started", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      examId: EXAM_ID,
      userId: "student1",
      status: "IN_PROGRESS",
      startedAt: null,
      effectiveEndTime: null,
      exam: { id: EXAM_ID, sebRequired: true },
    })
    expect((await save()).status).toBe(409)
    expectNothingWritten()
  })
})

describe("PUT /api/sessions/[id]/answers: validation", () => {
  it("rejects a malformed body", async () => {
    expect((await put({ questionId: "not-a-cuid" })).status).toBe(422)
    expectNothingWritten()
  })

  it("refuses a question that belongs to another exam", async () => {
    prismaMock.question.findUnique.mockResolvedValue({
      id: QUESTION_ID,
      examId: "c000000000000000000000099",
      type: "FREE_TEXT",
    })
    expect((await save()).status).toBe(404)
    expectNothingWritten()
  })

  it("refuses content whose type doesn't match the question", async () => {
    expect((await save({ type: "TRUE_FALSE", selected: true })).status).toBe(
      422
    )
    expectNothingWritten()
  })

  describe("file-upload answers", () => {
    beforeEach(() => {
      prismaMock.question.findUnique.mockResolvedValue({
        id: QUESTION_ID,
        examId: EXAM_ID,
        type: "FILE_UPLOAD",
      })
    })

    function fileAnswer(sessionId: string, questionId: string) {
      return {
        type: "FILE_UPLOAD",
        fileKey: `sessions/${sessionId}/${questionId}/${UUID}.pdf`,
        fileName: "abgabe.pdf",
      }
    }

    it("refuses a key that points at another session's upload", async () => {
      const res = await save(
        fileAnswer("c000000000000000000000077", QUESTION_ID)
      )
      expect(res.status).toBe(422)
      expectNothingWritten()
    })

    it("refuses a key that points at another question's upload", async () => {
      const res = await save(
        fileAnswer(SESSION_ID, "c000000000000000000000088")
      )
      expect(res.status).toBe(422)
      expectNothingWritten()
    })

    it("accepts a key for this session and question", async () => {
      expect((await save(fileAnswer(SESSION_ID, QUESTION_ID))).status).toBe(200)
    })
  })
})

describe("PUT /api/sessions/[id]/answers: write", () => {
  it("stores the answer and reports the new version", async () => {
    const res = await save(freeText, 4)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      saved: true,
      version: 3,
      savedAt: SAVED_AT.toISOString(),
      superseded: false,
    })
    expect(txMock.examSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: SESSION_ID,
        status: { in: expect.arrayContaining(["IN_PROGRESS"]) },
      },
      data: { lastSeenAt: expect.any(Date) },
    })
    expect(txMock.answer.findUniqueOrThrow).not.toHaveBeenCalled()
  })

  it("answers 409 when the session was locked or submitted in the meantime", async () => {
    txMock.examSession.updateMany.mockResolvedValue({ count: 0 })
    const res = await save()
    expect(res.status).toBe(409)
    expect((await res.json()).error.message).toBe("Sitzung ist nicht aktiv")
    expect(txMock.$queryRaw).not.toHaveBeenCalled()
  })

  it("marks the save superseded when a newer one is already stored", async () => {
    txMock.$queryRaw.mockResolvedValue([])
    txMock.answer.findUniqueOrThrow.mockResolvedValue({
      version: 7,
      updatedAt: SAVED_AT,
    })

    const res = await save(freeText, 2)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      saved: true,
      version: 7,
      savedAt: SAVED_AT.toISOString(),
      superseded: true,
    })
    expect(txMock.answer.findUniqueOrThrow).toHaveBeenCalledWith({
      where: {
        sessionId_questionId: {
          sessionId: SESSION_ID,
          questionId: QUESTION_ID,
        },
      },
      select: { version: true, updatedAt: true },
    })
  })
})
