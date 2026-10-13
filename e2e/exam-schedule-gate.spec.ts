import { test, expect, type APIRequestContext } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
} from "./helpers"

// Shares the file-wide auth rate-limit budget with the other spec files
// (see toctou-fixes.spec.ts) — keep this serial.
test.describe.configure({ mode: "serial" })

const ORIGIN_HEADER = {
  origin: new URL(
    process.env.E2E_BASE_URL ??
      process.env.TARGET_BASE_URL ??
      `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
  ).origin,
}

function isoIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

/**
 * The join window is enforced in POST /api/sessions, and refusing a join is
 * the only thing `scheduledStart`/`scheduledEnd` do — the gate is the single
 * choke point, so nothing else covers this.
 *
 * These assert the response a student actually receives, not just that the
 * join fails. The gate originally signalled refusal by throwing, but the only
 * `catch` that maps that to an HTTP response wraps the transaction further
 * down, so the throw escaped the handler: the join was correctly refused, but
 * as a bodyless 500 with no code for the join form to render. A unit test on
 * the gate predicate cannot see that; it lives in the wiring.
 */
test.describe.serial("exam schedule gate — the join window is enforced", () => {
  let teacher: APIRequestContext
  let student: APIRequestContext

  test.beforeAll(async ({ playwright }) => {
    teacher = await playwright.request.newContext()
    student = await playwright.request.newContext()

    const teacherEmail = uniqueEmail("schedule-teacher")
    await signUp(teacher, { name: "Schedule Teacher", email: teacherEmail })
    await promoteToTeacher(teacher, { email: teacherEmail })

    await signUp(student, {
      name: "Schedule Student",
      email: uniqueEmail("schedule-student"),
    })
  })

  test.afterAll(async () => {
    await teacher.dispose()
    await student.dispose()
  })

  test("joining before scheduledStart is refused as 403 NOT_STARTED", async () => {
    const exam = await createActiveExam(teacher, `Not Started ${Date.now()}`, {
      scheduledStart: isoIn(60),
      scheduledEnd: isoIn(120),
    })

    const res = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })

    expect(res.status(), await res.text()).toBe(403)
    expect(await res.json()).toMatchObject({
      error: {
        code: "NOT_STARTED",
        message: "Die Prüfung hat noch nicht begonnen.",
      },
    })
  })

  test("joining after scheduledEnd is refused as 403 EXAM_ENDED", async () => {
    const exam = await createActiveExam(teacher, `Ended ${Date.now()}`, {
      scheduledStart: isoIn(-120),
      scheduledEnd: isoIn(-60),
    })

    const res = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })

    expect(res.status(), await res.text()).toBe(403)
    expect(await res.json()).toMatchObject({
      error: {
        code: "EXAM_ENDED",
        message: "Die Prüfung ist bereits beendet.",
      },
    })
  })

  test("an exam inside its window still joins normally", async () => {
    const exam = await createActiveExam(teacher, `Open ${Date.now()}`, {
      scheduledStart: isoIn(-30),
      scheduledEnd: isoIn(30),
    })

    const res = await student.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })

    expect(res.ok(), await res.text()).toBe(true)
    expect((await res.json()).sessionId).toBeTruthy()
  })
})
