import { test, expect, type APIRequestContext } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  type SeededExam,
} from "./helpers"

// Must match the port playwright.config.ts starts the dev server on.
const ORIGIN_HEADER = {
  origin: new URL(
    process.env.E2E_BASE_URL ??
      process.env.TARGET_BASE_URL ??
      `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
  ).origin,
}
const RECOVERY_GRACE_MS = 5 * 60_000
const SWEEP_BUFFER_MS = 60_000
const POLL_INTERVAL_MS = 5_000

/**
 * T3 — Auto-submit past grace period.
 *
 * A student joins a 1-minute exam, answers a question, then stays "offline"
 * (no further API calls) past the time limit plus the 30s grace window.
 * The production sweeper closes the session after its five-minute recovery
 * grace, without a client submit. GET requests only observe the outcome.
 *
 * This is an API-level test — no browser needed, and the wait is
 * intentionally real (the deadline must actually pass server-side).
 */
test.describe("auto-submit past grace", () => {
  let exam: SeededExam
  let teacher: APIRequestContext

  test.beforeAll(async ({ playwright, baseURL }) => {
    teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("stress-t3-teacher")
    await signUp(teacher, { name: "Stress T3 Teacher", email })
    await promoteToTeacher(teacher, { email })

    const createRes = await teacher.post("/api/exams", {
      data: { title: `Stress T3 — Auto-Submit ${Date.now()}`, timeLimitMin: 1 },
    })
    expect(createRes.ok()).toBe(true)
    const { exam: created } = await createRes.json()

    const mcRes = await teacher.post(`/api/exams/${created.id}/questions`, {
      data: {
        title: "MC question",
        points: 1,
        required: true,
        type: "MULTIPLE_CHOICE",
        config: {
          multiSelect: false,
          options: [
            { id: "opt-a", text: "A", isCorrect: true },
            { id: "opt-b", text: "B", isCorrect: false },
          ],
        },
      },
    })
    expect(mcRes.ok()).toBe(true)

    await teacher.post(`/api/exams/${created.id}/publish`)
    await teacher.post(`/api/exams/${created.id}/activate`)

    exam = { id: created.id, accessCode: created.accessCode }
  })

  test.afterAll(async () => {
    await teacher.dispose()
  })

  test("offline past recovery grace → AUTO_SUBMITTED by server sweeper", async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(8 * 60_000)
    const student = await playwright.request.newContext({ baseURL })
    const studentEmail = uniqueEmail("stress-t3-student")
    await signUp(student, { name: "Stress T3 Student", email: studentEmail })

    const joinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), `join failed: ${await joinRes.text()}`).toBe(true)
    const { sessionId } = await joinRes.json()

    const takeRes = await student.get(`/api/sessions/${sessionId}`)
    const { questions, session } = await takeRes.json()
    const questionId = (questions as { id: string }[])[0].id

    const saved = await student.put(`/api/sessions/${sessionId}/answers`, {
      headers: ORIGIN_HEADER,
      data: {
        questionId,
        content: { type: "MULTIPLE_CHOICE", selectedOptionIds: ["opt-a"] },
      },
    })
    expect(saved.ok()).toBe(true)

    // Wait until the deadline plus grace window has elapsed, then check.
    const personalDeadline = Date.parse(session.effectiveEndTime)
    expect(Number.isFinite(personalDeadline)).toBe(true)
    const deadline = personalDeadline + RECOVERY_GRACE_MS + SWEEP_BUFFER_MS
    let submitted = false
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const checkRes = await student.get(`/api/sessions/${sessionId}`)
      if (checkRes.status() === 404) break // session gone
      const body = await checkRes.json()
      if (body.session?.status === "AUTO_SUBMITTED") {
        submitted = true
        break
      }
    }
    expect(submitted).toBe(true)

    const finalRes = await student.get(`/api/sessions/${sessionId}`)
    const finalBody = await finalRes.json()
    expect(finalBody.session.status).toBe("AUTO_SUBMITTED")
    await expect
      .poll(
        async () => {
          const reviewed = await teacher.get(
            `/api/sessions/${sessionId}/review`
          )
          const body = await reviewed.json()
          return {
            type: body.session?.submissionType,
            points: body.grades?.[0]?.points,
          }
        },
        { timeout: 15_000 }
      )
      .toEqual({ type: "AUTO_TIME", points: 1 })

    // Re-join must be rejected.
    const rejoinRes = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(rejoinRes.status()).toBe(409)

    await student.dispose()
  })
})
