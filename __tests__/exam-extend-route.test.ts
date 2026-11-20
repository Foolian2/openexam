import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, txMock, authMock, redisMock, auditMock, logErrorMock } =
  vi.hoisted(() => {
    const txMock = { $queryRaw: vi.fn() }
    return {
      txMock,
      prismaMock: {
        exam: { findUnique: vi.fn() },
        $transaction: vi.fn(async (fn: (tx: typeof txMock) => unknown) =>
          fn(txMock)
        ),
      },
      authMock: { api: { getSession: vi.fn() } },
      redisMock: { publish: vi.fn() },
      auditMock: vi.fn(),
      logErrorMock: vi.fn(),
    }
  })

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock }))
vi.mock("@/lib/logger", () => ({ logError: logErrorMock }))

import { POST } from "@/app/api/exams/[id]/extend/route"

const EXAM_ID = "exam1"
const END = new Date("2026-10-08T12:10:00Z")
const extended = [
  { id: "s1", effectiveEndTime: END, timeExtensionMin: 10, namApplied: false },
  { id: "s2", effectiveEndTime: END, timeExtensionMin: 15, namApplied: true },
]

function extend(body: unknown = { minutes: 10 }) {
  return POST(
    new NextRequest(`https://localhost/api/exams/${EXAM_ID}/extend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: EXAM_ID }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  prismaMock.exam.findUnique.mockResolvedValue({
    creatorId: "teacher1",
    status: "ACTIVE",
  })
  // First raw query: the FOR UPDATE re-read. Second: the set-based UPDATE.
  txMock.$queryRaw
    .mockResolvedValueOnce([{ status: "ACTIVE" }])
    .mockResolvedValueOnce(extended)
  redisMock.publish.mockResolvedValue(1)
})

function expectNoSideEffects() {
  expect(redisMock.publish).not.toHaveBeenCalled()
  expect(auditMock).not.toHaveBeenCalled()
}

describe("POST /api/exams/[id]/extend: access", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    expect((await extend()).status).toBe(401)
  })

  it("refuses students", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", role: "STUDENT" },
    })
    expect((await extend()).status).toBe(403)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it("hides another teacher's exam as 404", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      creatorId: "teacher2",
      status: "ACTIVE",
    })
    expect((await extend()).status).toBe(404)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it.each([0, -5, 241, 2.5, "10"])("rejects minutes = %j", async (minutes) => {
    expect((await extend({ minutes })).status).toBe(422)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

describe("POST /api/exams/[id]/extend: exam state", () => {
  it("refuses an exam that isn't active", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      creatorId: "teacher1",
      status: "CLOSED",
    })
    expect((await extend()).status).toBe(409)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it("refuses when the exam was closed between the check and the lock", async () => {
    txMock.$queryRaw.mockReset()
    txMock.$queryRaw.mockResolvedValueOnce([{ status: "CLOSED" }])

    const res = await extend()
    expect(res.status).toBe(409)
    // Only the lock query ran; the UPDATE never did.
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1)
    expectNoSideEffects()
  })

  it("locks the exam row before it touches any session", async () => {
    await extend()
    // Both queries are Prisma.sql objects. Without FOR UPDATE the re-read
    // doesn't serialize with the close endpoint, so a close could commit
    // between it and the UPDATE and sessions would still be extended.
    const [[lock], [update]] = txMock.$queryRaw.mock.calls
    expect(lock.sql).toMatch(
      /SELECT "status" FROM "Exam" WHERE "id" = \? FOR UPDATE/
    )
    expect(lock.values).toEqual([EXAM_ID])
    expect(update.sql).toMatch(/^\s*UPDATE "ExamSession"/)
  })

  it("also extends SEB sessions whose clock has not started yet", async () => {
    await extend()
    // NULL + interval stays NULL; the grant lands in timeExtensionMin and
    // the clock start folds it into the deadline.
    const [, [update]] = txMock.$queryRaw.mock.calls
    expect(update.sql).not.toMatch(/"effectiveEndTime" IS NOT NULL/)
  })
})

describe("POST /api/exams/[id]/extend: success", () => {
  it("returns the extended sessions", async () => {
    const res = await extend({ minutes: 10 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessionsAffected: 2,
      sessions: extended.map((s) => ({
        ...s,
        effectiveEndTime: END.toISOString(),
      })),
    })
  })

  it("pushes the new end time to each student over the control channel", async () => {
    await extend()
    expect(redisMock.publish).toHaveBeenCalledTimes(2)
    for (const s of extended) {
      expect(redisMock.publish).toHaveBeenCalledWith(
        `exam:${EXAM_ID}:control`,
        JSON.stringify({
          type: "SESSION_EXTENDED",
          sessionId: s.id,
          effectiveEndTime: s.effectiveEndTime,
          timeExtensionMin: s.timeExtensionMin,
          namApplied: s.namApplied,
        })
      )
    }
  })

  it("audits the extension", async () => {
    await extend({ minutes: 10 })
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXAM_TIME_EXTENDED",
        entityId: EXAM_ID,
        examId: EXAM_ID,
        userId: "teacher1",
        metadata: { minutes: 10, sessionsAffected: 2 },
      })
    )
  })

  it("still succeeds when a push fails, and logs it", async () => {
    redisMock.publish
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValue(1)

    const res = await extend()
    expect(res.status).toBe(200)
    expect(logErrorMock).toHaveBeenCalledWith(
      "SESSION_EXTENDED publish failed",
      expect.objectContaining({ examId: EXAM_ID, failed: 1, sessions: 2 })
    )
    expect(auditMock).toHaveBeenCalled()
  })

  it("succeeds with no active sessions", async () => {
    txMock.$queryRaw.mockReset()
    txMock.$queryRaw
      .mockResolvedValueOnce([{ status: "ACTIVE" }])
      .mockResolvedValueOnce([])

    const res = await extend()
    expect(res.status).toBe(200)
    expect((await res.json()).sessionsAffected).toBe(0)
    expect(redisMock.publish).not.toHaveBeenCalled()
  })
})
