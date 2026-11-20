import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { z } from "zod"
import { PrismaClient } from "@/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
const m = vi.hoisted(() => ({
  client: undefined as unknown,
  userId: "",
  audit: vi.fn(),
  finalize: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return m.client
  },
}))
vi.mock("@/lib/api-auth", () => ({
  requireStaff: vi.fn(async () => ({ user: { id: m.userId } })),
}))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
vi.mock("@/lib/finalize-session", () => ({ finalizeSession: m.finalize }))
const url = process.env.TEST_DATABASE_URL

// Identifies this suite's connections in pg_stat_activity: waitForLock must
// not match another client sharing the database (CI service container).
const APP_NAME = "exam-lifecycle-sql"

describe.skipIf(!url)("exam lifecycle against Postgres", () => {
  let db: PrismaClient
  let examId: string
  beforeAll(async () => {
    db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: url!,
        application_name: APP_NAME,
      }),
    })
    m.client = db
    m.userId = (
      await db.user.create({
        data: {
          name: "Lifecycle test",
          email: `lifecycle-${randomUUID()}@test.invalid`,
        },
      })
    ).id
  })
  beforeEach(async () => {
    m.client = db
    m.audit.mockClear()
    m.finalize.mockClear()
    examId = (
      await db.exam.create({
        data: {
          title: "Test",
          creatorId: m.userId,
          accessCode: randomUUID(),
          timeLimitMin: 60,
          status: "ACTIVE",
        },
      })
    ).id
  })
  afterEach(async () => {
    if (examId) {
      await db.examSession.deleteMany({ where: { examId } })
      await db.exam.deleteMany({ where: { id: examId } })
    }
  })
  afterAll(async () => {
    if (db) {
      if (m.userId) await db.user.deleteMany({ where: { id: m.userId } })
      await db.$disconnect()
    }
  })
  function create() {
    const now = new Date()
    return {
      examId,
      userId: m.userId,
      status: "IN_PROGRESS" as const,
      startedAt: now,
      effectiveEndTime: new Date(now.getTime() + 3600000),
      lastSeenAt: now,
    }
  }
  async function waitForLock(fragment: string) {
    for (let n = 0; n < 100; n++) {
      const rows = await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity
          WHERE application_name = ${APP_NAME}
            AND usename = current_user
            AND pid <> pg_backend_pid()
            AND query LIKE ${`%${fragment}%`}
            AND wait_event_type='Lock'
        ) AS waiting`
      if (rows[0].waiting) return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`query did not wait for the parent lock: ${fragment}`)
  }
  it("does not create a live session when close commits while admission waits", async () => {
    const { joinActiveExam } = await import("@/lib/join-active-exam")
    let locked!: () => void, release!: () => void
    const ready = new Promise<void>((r) => {
        locked = r
      }),
      held = new Promise<void>((r) => {
        release = r
      })
    const close = db.$transaction(async (tx) => {
      await tx.exam.update({
        where: { id: examId },
        data: { status: "CLOSED" },
      })
      locked()
      await held
    })
    await ready
    const joining = joinActiveExam(create())
    try {
      await waitForLock("WITH active_exam")
    } finally {
      release()
      await close
    }
    expect(await joining).toBeNull()
    expect(await db.examSession.count({ where: { examId } })).toBe(0)
  })
  it("claims the session of a join that won the share lock", async () => {
    const { joinActiveExam } = await import("@/lib/join-active-exam")
    const { POST: closeExam } = await import("@/app/api/exams/[id]/close/route")
    let admitted!: () => void, releaseJoin!: () => void
    const joined = new Promise<void>((r) => {
        admitted = r
      }),
      holdJoin = new Promise<void>((r) => {
        releaseJoin = r
      })
    // Twin of the test above: here the join wins the exam share lock. Running
    // the real single-statement join inside an open transaction keeps that
    // FOR SHARE lock held while close starts — the interleaving where close
    // must still see the session.
    const joinTx = db.$transaction(async (tx) => {
      m.client = tx
      const session = await joinActiveExam(create())
      admitted()
      await holdJoin
      return session
    })
    await joined
    m.client = db
    // The real close route (app/api/exams/[id]/close/route.ts) gates on the
    // exam-status UPDATE and only then claims sessions. That order is
    // load-bearing: moving the claim before the UPDATE would run it before
    // the join commits and this test would fail.
    const closing = closeExam(
      new NextRequest(`http://localhost/api/exams/${examId}/close`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: examId }) }
    )
    try {
      await waitForLock("UPDATE")
    } finally {
      releaseJoin()
    }
    const [session, res] = await Promise.all([joinTx, closing])
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ forcedSubmissions: 1 })
    const claimed = await db.examSession.findUniqueOrThrow({
      where: { id: session!.id },
    })
    expect(claimed.status).toBe("AUTO_SUBMITTED")
    expect(claimed.submissionType).toBe("TEACHER_FORCED")
  })
  it("coalesces simultaneous first joins and preserves supported session IDs", async () => {
    const { joinActiveExam } = await import("@/lib/join-active-exam")
    const sessions = await Promise.all(
      Array.from({ length: 12 }, () => joinActiveExam(create()))
    )
    expect(new Set(sessions.map((s) => s!.id)).size).toBe(1)
    expect(z.string().cuid().safeParse(sessions[0]!.id).success).toBe(true)
    expect(await db.examSession.count({ where: { examId } })).toBe(1)
    await db.examSession.update({
      where: { id: sessions[0]!.id },
      data: { status: "LOCKED" },
    })
    expect(await joinActiveExam(create())).toBeNull()
  })
  it("preserves the first join's clock when a later admission hits the conflict", async () => {
    const { joinActiveExam } = await import("@/lib/join-active-exam")
    const first = await joinActiveExam(create())
    expect(first).not.toBeNull()
    const later = new Date(first!.lastSeenAt!.getTime() + 60_000)
    // A late duplicate computes a fresh clock; only lastSeenAt may apply.
    const second = await joinActiveExam({
      ...create(),
      startedAt: null,
      effectiveEndTime: null,
      lastSeenAt: later,
    })
    expect(second).not.toBeNull()
    expect(second!.id).toBe(first!.id)
    expect(second!.startedAt?.getTime()).toBe(first!.startedAt?.getTime())
    expect(second!.effectiveEndTime?.getTime()).toBe(
      first!.effectiveEndTime?.getTime()
    )
    expect(second!.lastSeenAt?.getTime()).toBe(later.getTime())
  })
  it("inserts the status the caller binds, not a hardcoded literal", async () => {
    const { joinActiveExam } = await import("@/lib/join-active-exam")
    // The interface narrows status to IN_PROGRESS today. The cast past that
    // narrowing proves the statement binds the parameter instead of a
    // literal, so a later widening of the callers cannot be silently
    // ignored.
    const session = await joinActiveExam({
      ...create(),
      status: "WAITING" as unknown as "IN_PROGRESS",
    })
    expect(session!.status).toBe("WAITING")
  })
  it("does not delete an exam published while deletion waits", async () => {
    await db.exam.update({ where: { id: examId }, data: { status: "DRAFT" } })
    let locked!: () => void, release!: () => void
    const ready = new Promise<void>((r) => {
        locked = r
      }),
      held = new Promise<void>((r) => {
        release = r
      })
    const publish = db.$transaction(async (tx) => {
      await tx.exam.update({
        where: { id: examId },
        data: { status: "PUBLISHED" },
      })
      locked()
      await held
    })
    await ready
    const { DELETE } = await import("@/app/api/exams/[id]/route")
    const deleting = DELETE(
      new NextRequest(`http://localhost/api/exams/${examId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: examId }) }
    )
    try {
      await waitForLock("DELETE FROM")
    } finally {
      release()
      await publish
    }
    expect((await deleting).status).toBe(409)
    expect(
      (await db.exam.findUniqueOrThrow({ where: { id: examId } })).status
    ).toBe("PUBLISHED")
    expect(m.audit).not.toHaveBeenCalled()
  })
})
