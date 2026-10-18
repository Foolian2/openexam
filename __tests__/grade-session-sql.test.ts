import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
const m = vi.hoisted(() => ({ client: undefined as unknown }))
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return m.client
  },
}))
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)("grading serialization against Postgres", () => {
  let base: PrismaClient
  let userId: string
  let examId: string
  let questionId: string
  let sessionId: string
  beforeAll(async () => {
    base = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url! }),
    })
    const tag = randomUUID()
    userId = (
      await base.user.create({
        data: { email: `grade-lock-${tag}@test.invalid`, name: "Test" },
      })
    ).id
    examId = (
      await base.exam.create({
        data: {
          title: "Test",
          accessCode: tag,
          timeLimitMin: 60,
          creatorId: userId,
        },
      })
    ).id
    questionId = (
      await base.question.create({
        data: {
          examId,
          title: "Test",
          order: 0,
          type: "TRUE_FALSE",
          points: 4,
          config: { isCorrect: true },
        },
      })
    ).id
    sessionId = (
      await base.examSession.create({
        data: { examId, userId, status: "SUBMITTED", needsRegrade: true },
      })
    ).id
    await base.answer.create({
      data: {
        sessionId,
        questionId,
        content: { type: "TRUE_FALSE", selected: false },
      },
    })
    await base.grade.create({
      data: {
        sessionId,
        questionId,
        points: 0,
        maxPoints: 4,
        autoGraded: true,
      },
    })
  })
  afterAll(async () => {
    if (!base) return
    if (sessionId) {
      await base.grade.deleteMany({ where: { sessionId } })
      await base.examSession.deleteMany({ where: { id: sessionId } })
    }
    if (examId) await base.exam.deleteMany({ where: { id: examId } })
    if (userId) await base.user.deleteMany({ where: { id: userId } })
    await base.$disconnect()
  })
  it("holds SELECT ... FOR UPDATE on the session across the answer read and grade write, then grades a late flush", async () => {
    // A blocker transaction grabs the session row first so that grader #1's
    // own lock statement is deterministically caught as its backend's
    // *current*, blocked query in pg_stat_activity. Asserting on the text of
    // that query is what discriminates the exclusive row lock this fix
    // depends on from a weaker FOR SHARE (or a missing lock), which would
    // still let two graders read the same stale answers concurrently.
    let releaseBlocker!: () => void
    let blockerHolds!: () => void
    const blockerHeld = new Promise<void>((r) => {
      releaseBlocker = r
    })
    const blockerIsHolding = new Promise<void>((r) => {
      blockerHolds = r
    })
    const blocker = base.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ExamSession" WHERE id = ${sessionId} FOR UPDATE`
      blockerHolds()
      await blockerHeld
    })

    let release!: () => void
    let read!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const reached = new Promise<void>((r) => {
      read = r
    })
    let reads = 0
    m.client = base.$extends({
      query: {
        examSession: {
          async findUnique({ args, query }) {
            const result = await query(args)
            if (++reads === 1) {
              read()
              await held
            }
            return result
          },
        },
      },
    })
    const { autoGradeSession } = await import("@/lib/grading/grade-session")
    // Wait until the blocker definitely holds the row; only then can grader
    // #1's own lock statement be the one observed waiting.
    await blockerIsHolding
    const first = autoGradeSession(sessionId)
    let late: Promise<void> | undefined
    try {
      let blockedQuery: string | null = null
      for (let n = 0; n < 200; n++) {
        const rows = await base.$queryRaw<{ query: string }[]>`
          SELECT query FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query LIKE ${'%"ExamSession"%'}
          LIMIT 1`
        if (rows.length > 0) {
          blockedQuery = rows[0].query
          break
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(blockedQuery).not.toBeNull()
      // A FOR SHARE lock (or none at all, leaving the UPDATE to block) fails
      // here with the offending statement text in the message.
      expect(blockedQuery).toMatch(
        /SELECT[\s\S]*"ExamSession"[\s\S]*FOR UPDATE/
      )

      releaseBlocker()
      await blocker
      await reached

      late = base.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "ExamSession" SET "needsRegrade" = true WHERE id = ${sessionId} /* release-test-late-flush */`
        await tx.answer.update({
          where: { sessionId_questionId: { sessionId, questionId } },
          data: { content: { type: "TRUE_FALSE", selected: true } },
        })
      })
      let waiting = false
      for (let n = 0; n < 100; n++) {
        const rows = await base.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE '%release-test-late-flush%' AND wait_event_type = 'Lock') AS waiting`
        if (rows[0].waiting) {
          waiting = true
          break
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(waiting).toBe(true)
    } finally {
      // Safe to call twice: the normal path already released the blocker and
      // grader #1, this only rescues the failure paths so a failed assertion
      // cannot leave a paused transaction holding the session row.
      releaseBlocker()
      release()
      await blocker
      await first
      if (late) await late
    }
    await autoGradeSession(sessionId)
    expect(
      (
        await base.grade.findUniqueOrThrow({
          where: { sessionId_questionId: { sessionId, questionId } },
        })
      ).points
    ).toBe(4)
    expect(
      (await base.examSession.findUniqueOrThrow({ where: { id: sessionId } }))
        .needsRegrade
    ).toBe(false)
  })

  it("only clears needsRegrade inside the still-open grading transaction, so a failed run leaves it set", async () => {
    await base.examSession.update({
      where: { id: sessionId },
      data: { needsRegrade: true },
    })
    let release!: () => void
    let read!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const reached = new Promise<void>((r) => {
      read = r
    })
    let reads = 0
    m.client = base.$extends({
      query: {
        examSession: {
          async findUnique({ args, query }) {
            const result = await query(args)
            if (++reads === 1) {
              read()
              await held
              throw new Error("injected grading failure")
            }
            return result
          },
        },
      },
    })
    const { autoGradeSession } = await import("@/lib/grading/grade-session")
    const grading = autoGradeSession(sessionId)
    // Attach the rejection handler up front: if the mid-run assertion below
    // fails, the test unwinds before awaiting `grading`, and the raw
    // rejection would otherwise surface as an unhandled promise.
    const outcome = grading.then(
      () => null,
      (err: unknown) => err
    )
    await reached
    try {
      // Another session must still see needsRegrade = true while this run is
      // open: the flag clear lives in the same transaction as the grading
      // read it precedes. The previous implementation committed the clear on
      // its own before grading, so this read observed false even though the
      // run later failed without writing any grade — and a concurrent grader
      // could then restore a stale result.
      const observed = await base.examSession.findUniqueOrThrow({
        where: { id: sessionId },
      })
      expect(observed.needsRegrade).toBe(true)
    } finally {
      release()
    }
    const failure = await outcome
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("injected grading failure")
    // The failed run rolled back its flag clear with it.
    expect(
      (await base.examSession.findUniqueOrThrow({ where: { id: sessionId } }))
        .needsRegrade
    ).toBe(true)
  })
})
