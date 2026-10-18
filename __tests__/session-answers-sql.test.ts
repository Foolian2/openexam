import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { NextRequest } from "next/server"
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@/generated/prisma/client"

// Real-Postgres check of the autosave route's ordering guard, the raw
// INSERT ... ON CONFLICT ... WHERE that keeps an older save from replacing a
// newer one. Mocks can't exercise that predicate, so this runs the route
// against a migrated database, like
// ws-backend/internal/store/store_integration_test.go does for the flusher's
// copy of the same predicate. Point TEST_DATABASE_URL at an expendable DB
// (e.g. the dev compose Postgres); without it the suite is skipped.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

const { authMock } = vi.hoisted(() => ({
  authMock: { api: { getSession: vi.fn() } },
}))

vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}))
vi.mock("@/lib/seb-guard", () => ({
  verifySebAccess: vi.fn(async () => ({ ok: true })),
}))
vi.mock("@/lib/seb-urls", () => ({
  publicRequestUrl: () => "https://localhost/answers",
}))

type Route = typeof import("@/app/api/sessions/[id]/answers/route")

describe.skipIf(!TEST_DATABASE_URL)("answers route against Postgres", () => {
  let prisma: PrismaClient
  let PUT: Route["PUT"]
  // Each id is assigned right after its row is created, and every cleanup
  // checks its id first: Prisma drops `undefined` filters, so a
  // `deleteMany({ where: { sessionId: undefined } })` after a failed setup
  // would wipe the whole table instead of this suite's rows.
  let userId: string | undefined
  let examId: string | undefined
  let questionId: string | undefined
  let sessionId: string | undefined

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ PUT } = await import("@/app/api/sessions/[id]/answers/route"))

    const tag = randomUUID()
    userId = (
      await prisma.user.create({
        data: { email: `answers-sql-${tag}@test.invalid`, name: "SQL Test" },
      })
    ).id
    examId = (
      await prisma.exam.create({
        data: {
          title: "answers-sql",
          accessCode: `T${tag.slice(0, 8)}`,
          timeLimitMin: 60,
          creatorId: userId,
        },
      })
    ).id
    questionId = (
      await prisma.question.create({
        data: {
          examId,
          type: "FREE_TEXT",
          order: 0,
          title: "Q",
          points: 1,
          config: {},
        },
      })
    ).id
    sessionId = (
      await prisma.examSession.create({
        data: {
          examId,
          userId,
          status: "IN_PROGRESS",
          startedAt: new Date(),
          effectiveEndTime: new Date(Date.now() + 60 * 60 * 1000),
        },
      })
    ).id
  })

  async function clearAnswers() {
    if (sessionId) await prisma.answer.deleteMany({ where: { sessionId } })
  }

  afterAll(async () => {
    if (!prisma) return
    await clearAnswers()
    if (examId) {
      await prisma.examSession.deleteMany({ where: { examId } })
      await prisma.question.deleteMany({ where: { examId } })
      await prisma.exam.deleteMany({ where: { id: examId } })
    }
    if (userId) await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: userId, role: "STUDENT" },
    })
    await clearAnswers()
  })

  function fixture() {
    if (!sessionId || !questionId) throw new Error("fixture setup failed")
    return { sessionId, questionId }
  }

  async function save(text: string, clientSeq?: number) {
    const { sessionId, questionId } = fixture()
    const res = await PUT(
      new NextRequest(`https://localhost/api/sessions/${sessionId}/answers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId,
          content: { type: "FREE_TEXT", text },
          clientSeq,
        }),
      }),
      { params: Promise.resolve({ id: sessionId }) }
    )
    expect(res.status).toBe(200)
    return res.json()
  }

  async function stored() {
    const { sessionId, questionId } = fixture()
    return prisma.answer.findUniqueOrThrow({
      where: { sessionId_questionId: { sessionId, questionId } },
      select: { content: true, version: true, clientSeq: true },
    })
  }

  it("keeps the newer save when an older one arrives late", async () => {
    await save("neu", 2)
    const late = await save("alt", 1)

    expect(late.superseded).toBe(true)
    expect(await stored()).toEqual({
      content: { type: "FREE_TEXT", text: "neu" },
      version: 1,
      clientSeq: 2,
    })
  })

  it("replaces an older save with a newer one", async () => {
    await save("eins", 1)
    const next = await save("zwei", 2)

    expect(next).toMatchObject({ superseded: false, version: 2 })
    expect(await stored()).toEqual({
      content: { type: "FREE_TEXT", text: "zwei" },
      version: 2,
      clientSeq: 2,
    })
  })

  it("treats an equal seq as a duplicate, not an update", async () => {
    await save("erste", 3)
    const dup = await save("zweite", 3)

    expect(dup.superseded).toBe(true)
    expect((await stored()).content).toEqual({
      type: "FREE_TEXT",
      text: "erste",
    })
  })

  it("always writes a save without a seq, and keeps the stored seq", async () => {
    await save("mit seq", 5)
    const legacy = await save("ohne seq")

    expect(legacy.superseded).toBe(false)
    expect(await stored()).toEqual({
      content: { type: "FREE_TEXT", text: "ohne seq" },
      version: 2,
      clientSeq: 5,
    })
  })
})
