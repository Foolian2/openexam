import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  prismaMock,
  txMock,
  authMock,
  auditMock,
  redisMock,
  sebMock,
  finalizeMock,
} = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    exam: { findUnique: vi.fn(), updateMany: vi.fn() },
  },
  txMock: {
    $queryRaw: vi.fn(),
    exam: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    question: { count: vi.fn() },
    examSession: { findMany: vi.fn(), updateMany: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
  auditMock: { createAuditLog: vi.fn() },
  redisMock: { redis: { publish: vi.fn() } },
  sebMock: { computeSebConfigKey: vi.fn() },
  finalizeMock: { regradeFlaggedSessions: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock.createAuditLog }))
vi.mock("@/lib/redis", () => ({ redis: redisMock.redis }))
vi.mock("@/lib/seb-issuance", () => ({
  computeSebConfigKey: sebMock.computeSebConfigKey,
}))
vi.mock("@/lib/finalize-session", () => ({
  regradeFlaggedSessions: finalizeMock.regradeFlaggedSessions,
}))

const ID = "c000000000000000000000001"
function post() {
  return new NextRequest(`http://localhost/api/exams/${ID}/x`, {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
  })
}
const params = { params: Promise.resolve({ id: ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "t1", role: "TEACHER" },
  })
  auditMock.createAuditLog.mockResolvedValue(undefined)
  redisMock.redis.publish.mockResolvedValue(undefined)
  finalizeMock.regradeFlaggedSessions.mockResolvedValue(undefined)
  prismaMock.$transaction.mockImplementation((callback) => callback(txMock))
  txMock.$queryRaw.mockResolvedValue([
    { id: ID, creatorId: "t1", status: "PUBLISHED" },
  ])
  txMock.exam.findUnique.mockResolvedValue({
    id: ID,
    creatorId: "t1",
    status: "PUBLISHED",
    sebRequired: false,
    sebConfigKey: null,
  })
  txMock.exam.findUniqueOrThrow.mockResolvedValue({ id: ID, status: "ACTIVE" })
  txMock.exam.updateMany.mockResolvedValue({ count: 1 })
  txMock.question.count.mockResolvedValue(1)
  txMock.examSession.findMany.mockResolvedValue([])
})

describe("publish guard", () => {
  it("409s when the DRAFT predicate loses the race (count 0)", async () => {
    prismaMock.exam.findUnique.mockResolvedValueOnce({
      id: ID,
      creatorId: "t1",
      status: "DRAFT",
      _count: { questions: 1 },
    })
    prismaMock.exam.updateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import("@/app/api/exams/[id]/publish/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(409)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, status: "DRAFT" } })
    )
  })
  it("200s when it wins", async () => {
    prismaMock.exam.findUnique
      .mockResolvedValueOnce({
        id: ID,
        creatorId: "t1",
        status: "DRAFT",
        _count: { questions: 1 },
      })
      .mockResolvedValueOnce({ id: ID, status: "PUBLISHED" })
    prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
    const { POST } = await import("@/app/api/exams/[id]/publish/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(200)
  })
})

describe("activate guard", () => {
  it("409s (not published) when the PUBLISHED predicate loses the race", async () => {
    txMock.$queryRaw.mockResolvedValue([
      { id: ID, creatorId: "t1", status: "ACTIVE" },
    ])
    const { POST } = await import("@/app/api/exams/[id]/activate/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(409)
    expect(txMock.exam.updateMany).not.toHaveBeenCalled()
  })
  it("200s and broadcasts exactly once when it wins", async () => {
    const { POST } = await import("@/app/api/exams/[id]/activate/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(200)
    expect(txMock.$queryRaw.mock.calls[0][0].text).toContain("FOR UPDATE")
    expect(txMock.question.count).toHaveBeenCalledOnce()
    expect(txMock.exam.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ID, status: "PUBLISHED" }),
      })
    )
    expect(redisMock.redis.publish).toHaveBeenCalledTimes(1)
  })
})

describe("activate: shared start", () => {
  it("starts every waiting session at one shared instant, keeping each grant", async () => {
    txMock.exam.findUniqueOrThrow.mockResolvedValue({
      id: ID,
      status: "PUBLISHED",
      sebRequired: false,
      timeLimitMin: 60,
      waitingRoom: true,
    })
    // Two distinct pre-start grants: none, and a Nachteilsausgleich of 9 min.
    txMock.examSession.findMany.mockResolvedValue([
      { timeExtensionMin: 0 },
      { timeExtensionMin: 9 },
    ])
    txMock.examSession.updateMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 1 })
    const before = Date.now()
    const { POST } = await import("@/app/api/exams/[id]/activate/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.startedWaiting).toBe(4)

    // The waiting rows are locked before they are grouped by grant, so a
    // concurrent pre-start extension cannot slip between read and update.
    // Tagged-template calls pass the string parts; Prisma.sql passes .text.
    const sql = (arg: { text?: string } | string[]) =>
      Array.isArray(arg) ? arg.join("") : (arg.text ?? "")
    const sessionLock = txMock.$queryRaw.mock.calls.findIndex((c) =>
      sql(c[0]).includes('FROM "ExamSession"')
    )
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sql(txMock.$queryRaw.mock.calls[sessionLock][0])).toContain(
      "FOR UPDATE"
    )
    expect(txMock.$queryRaw.mock.invocationCallOrder[sessionLock]).toBeLessThan(
      txMock.examSession.findMany.mock.invocationCallOrder[0]
    )

    const calls = txMock.examSession.updateMany.mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.where).toMatchObject({ examId: ID, status: "WAITING" })
      expect(call.data.status).toBe("IN_PROGRESS")
    }
    // One shared start, 10 s after the press (the visible countdown).
    const start = calls[0].data.startedAt as Date
    expect(calls[1].data.startedAt).toEqual(start)
    expect(start.getTime() - before).toBeGreaterThanOrEqual(10_000)
    expect(start.getTime() - before).toBeLessThan(11_000)
    expect(new Date(body.startsAt)).toEqual(start)
    // Full time limit from the shared start, plus each session's own grant.
    expect(calls[0].where.timeExtensionMin).toBe(0)
    expect(calls[0].data.effectiveEndTime).toEqual(
      new Date(start.getTime() + 60 * 60_000)
    )
    expect(calls[1].where.timeExtensionMin).toBe(9)
    expect(calls[1].data.effectiveEndTime).toEqual(
      new Date(start.getTime() + 69 * 60_000)
    )
    expect(auditMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXAM_ACTIVATED",
        metadata: { waitingStudents: 4, startsAt: start.toISOString() },
      })
    )
  })

  it("starts no clock when nobody is waiting", async () => {
    const { POST } = await import("@/app/api/exams/[id]/activate/route")
    const res = await POST(post(), params)
    const body = await res.json()
    expect(body).toMatchObject({ startedWaiting: 0, startsAt: null })
    expect(txMock.examSession.updateMany).not.toHaveBeenCalled()
  })
})

describe("mark-graded guard", () => {
  it("409s when the CLOSED predicate loses to a concurrent archive", async () => {
    prismaMock.exam.findUnique.mockResolvedValueOnce({
      id: ID,
      creatorId: "t1",
      status: "CLOSED",
    })
    prismaMock.exam.updateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import("@/app/api/exams/[id]/mark-graded/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(409)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ID, status: "CLOSED" } })
    )
  })
  it("200s when it wins", async () => {
    prismaMock.exam.findUnique
      .mockResolvedValueOnce({ id: ID, creatorId: "t1", status: "CLOSED" })
      .mockResolvedValueOnce({ id: ID, status: "GRADED" })
    prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
    const { POST } = await import("@/app/api/exams/[id]/mark-graded/route")
    const res = await POST(post(), params)
    expect(res.status).toBe(200)
  })
})
