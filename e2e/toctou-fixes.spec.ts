import { test, expect, type APIRequestContext } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
} from "./helpers"

// lib/account-rate-limit.ts FAILED_SIGN_IN_LIMIT (not imported: that module
// pulls in the Redis client).
const FAILED_SIGN_IN_LIMIT = 50

// The last describe block below deliberately saturates a Redis-backed
// sign-in limit — force the whole file to run serially (overriding the
// project's fullyParallel) so that saturation can't race against another
// describe block's own sign-in calls.
test.describe.configure({ mode: "serial" })

// Must match the port playwright.config.ts starts the dev server on.
const BASE_URL =
  process.env.E2E_BASE_URL ??
  process.env.TARGET_BASE_URL ??
  `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
const ORIGIN_HEADER = {
  origin: new URL(BASE_URL).origin,
}

/**
 * Creates a second request context sharing the same session cookies as
 * `source`, so concurrent requests can be fired as the *same* authenticated
 * identity (simulating two requests landing on two different instances).
 */
async function cloneAuthenticatedContext(
  playwright: typeof import("@playwright/test").request,
  source: APIRequestContext,
  baseURL: string
): Promise<APIRequestContext> {
  const state = await source.storageState()
  return playwright.newContext({ baseURL, storageState: state })
}

/**
 * All tests share one teacher and one student account (created once) to
 * keep sign-ups and sign-ins against the per-IP limits in lib/auth.ts low —
 * the Redis-backed limiter (item 8 of the audit) enforces them across the
 * whole worker pool, not per test.
 */
test.describe.serial("TOCTOU fixes — concurrency races", () => {
  let teacher: APIRequestContext
  let student: APIRequestContext
  let baseURL: string

  test.beforeAll(async ({ playwright, baseURL: url }) => {
    baseURL = url!
    teacher = await playwright.request.newContext({ baseURL })
    const teacherEmail = uniqueEmail("toctou-teacher")
    await signUp(teacher, { name: "E2E Teacher", email: teacherEmail })
    await promoteToTeacher(teacher, { email: teacherEmail })

    student = await playwright.request.newContext({ baseURL })
    await signUp(student, {
      name: "E2E Student",
      email: uniqueEmail("toctou-student"),
    })
  })

  test.afterAll(async () => {
    await teacher.dispose()
    await student.dispose()
  })

  test("concurrent lock requests: exactly one succeeds, final status is consistent", async ({
    playwright,
  }) => {
    const exam = await createActiveExam(teacher, `TOCTOU Lock ${Date.now()}`)
    const joinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()

    const teacherB = await cloneAuthenticatedContext(
      playwright.request,
      teacher,
      baseURL
    )
    try {
      const [resA, resB] = await Promise.all([
        teacher.post(`/api/sessions/${sessionId}/lock`, {
          data: { locked: true },
        }),
        teacherB.post(`/api/sessions/${sessionId}/lock`, {
          data: { locked: true },
        }),
      ])

      const statuses = [resA.status(), resB.status()].sort()
      expect(statuses).toEqual([200, 409])

      const listRes = await teacher.get(`/api/exams/${exam.id}/sessions`)
      const { sessions } = await listRes.json()
      const found = sessions.find((s: { id: string }) => s.id === sessionId)
      expect(found.status).toBe("LOCKED")
    } finally {
      await teacherB.dispose()
    }
  })

  test("locked session rejects answer save and rejoin", async () => {
    const exam = await createActiveExam(teacher, `TOCTOU Locked ${Date.now()}`)
    const joinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()

    const lockRes = await teacher.post(`/api/sessions/${sessionId}/lock`, {
      data: { locked: true },
    })
    expect(lockRes.ok()).toBe(true)

    // Answer save must be rejected now that the session is locked (status
    // gate is re-checked inside the write transaction, not a stale read).
    const takeRes = await student.get(`/api/sessions/${sessionId}`)
    const takeBody = await takeRes.json()
    const questionId = takeBody.questions[0].id

    const answerRes = await student.put(`/api/sessions/${sessionId}/answers`, {
      data: {
        questionId,
        content: { type: "MULTIPLE_CHOICE", selectedOptionIds: [] },
      },
    })
    expect(answerRes.status()).toBe(409)

    // Rejoin must also be rejected while locked (the join-route TOCTOU fix).
    const rejoinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(rejoinRes.status()).toBe(403)
  })

  test("concurrent exam close: exactly one succeeds, sessions force-submitted once", async ({
    playwright,
  }) => {
    const exam = await createActiveExam(teacher, `TOCTOU Close ${Date.now()}`)
    const joinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()

    const teacherB = await cloneAuthenticatedContext(
      playwright.request,
      teacher,
      baseURL
    )
    try {
      const [resA, resB] = await Promise.all([
        teacher.post(`/api/exams/${exam.id}/close`),
        teacherB.post(`/api/exams/${exam.id}/close`),
      ])

      const results = [resA, resB]
      const okOnes = results.filter((r) => r.ok())
      const conflictOnes = results.filter((r) => r.status() === 409)
      expect(okOnes.length).toBe(1)
      expect(conflictOnes.length).toBe(1)

      const body = await okOnes[0].json()
      expect(body.forcedSubmissions).toBe(1)

      const listRes = await teacher.get(`/api/exams/${exam.id}/sessions`)
      const { sessions, exam: examOut } = await listRes.json()
      expect(examOut.status).toBe("CLOSED")
      const found = sessions.find((s: { id: string }) => s.id === sessionId)
      expect(found.status).toBe("AUTO_SUBMITTED")
    } finally {
      await teacherB.dispose()
    }
  })

  test("concurrent SEB config downloads don't error under a race", async ({
    playwright,
  }) => {
    const createRes = await teacher.post("/api/exams", {
      data: {
        title: `TOCTOU SEB ${Date.now()}`,
        timeLimitMin: 30,
        sebRequired: true,
      },
    })
    expect(createRes.ok(), await createRes.text()).toBe(true)
    const { exam } = await createRes.json()

    const teacherB = await cloneAuthenticatedContext(
      playwright.request,
      teacher,
      baseURL
    )
    try {
      const [resA, resB] = await Promise.all([
        teacher.get(`/api/exams/${exam.id}/seb-config`),
        teacherB.get(`/api/exams/${exam.id}/seb-config`),
      ])
      expect(resA.ok(), await resA.text()).toBe(true)
      expect(resB.ok(), await resB.text()).toBe(true)
    } finally {
      await teacherB.dispose()
    }
  })

  test("submitted exam is graded automatically and visible in teacher review", async () => {
    const exam = await createActiveExam(teacher, `TOCTOU Grade ${Date.now()}`)
    const joinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()

    const takeRes = await student.get(`/api/sessions/${sessionId}`)
    const takeBody = await takeRes.json()
    const mcQuestion = takeBody.questions.find(
      (q: { type: string }) => q.type === "MULTIPLE_CHOICE"
    )

    const answerRes = await student.put(`/api/sessions/${sessionId}/answers`, {
      data: {
        questionId: mcQuestion.id,
        content: { type: "MULTIPLE_CHOICE", selectedOptionIds: ["opt-bern"] },
      },
    })
    expect(answerRes.ok(), await answerRes.text()).toBe(true)

    const submitRes = await student.post(`/api/sessions/${sessionId}/submit`, {
      data: { idempotencyKey: `toctou-${sessionId}` },
    })
    expect(submitRes.ok(), await submitRes.text()).toBe(true)

    const reviewRes = await teacher.get(`/api/sessions/${sessionId}/review`)
    expect(reviewRes.ok(), await reviewRes.text()).toBe(true)
    const review = await reviewRes.json()
    const mcGrade = review.grades.find(
      (g: { questionId: string }) => g.questionId === mcQuestion.id
    )
    expect(mcGrade).toBeTruthy()
    expect(mcGrade.autoGraded).toBe(true)
    expect(mcGrade.points).toBe(2)
  })
})

/**
 * Failed password sign-ins per IP (lib/account-rate-limit.ts,
 * FAILED_SIGN_IN_LIMIT): better-auth's per-IP sign-in rule admits a whole
 * school NAT (200/min), so password spraying is stopped by counting wrong
 * guesses per address in Redis instead. Each attempt targets a different
 * email, so the per-account limit (10 per account) never engages and only
 * the per-IP failure counter can refuse. The request carries its own
 * X-Forwarded-For (CI has no nginx in front), a fresh address per run so the
 * count starts at 0 and no other test shares it.
 */
test.describe("TOCTOU fixes — rate limiting", () => {
  test("failed sign-ins per IP are limited with Redis-backed storage", async ({
    playwright,
    baseURL,
  }) => {
    const ip = `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`
    const ctx = await playwright.request.newContext({
      baseURL: baseURL!,
      extraHTTPHeaders: { "x-forwarded-for": ip },
    })

    const statuses: number[] = []
    for (let i = 0; i <= FAILED_SIGN_IN_LIMIT; i++) {
      const res = await ctx.post("/api/auth/sign-in/email", {
        headers: ORIGIN_HEADER,
        data: {
          email: uniqueEmail(`toctou-spray-${i}`),
          password: "wrong-password-attempt",
        },
      })
      statuses.push(res.status())
    }

    // Every attempt up to the limit is a plain wrong-credentials refusal;
    // the next one is refused by the per-IP failure counter.
    expect(statuses.slice(0, FAILED_SIGN_IN_LIMIT)).not.toContain(429)
    expect(statuses[FAILED_SIGN_IN_LIMIT]).toBe(429)

    await ctx.dispose()
  })
})
