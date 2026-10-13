import { test, expect, type APIRequestContext } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  teacherExportCsv,
  parseCsv,
  type SeededExam,
} from "./helpers"

const STUDENT_COUNT = Math.max(1, Number(process.env.STRESS_STUDENTS) || 3)

/**
 * T9 — Full lifecycle with N concurrent real-browser students.
 *
 * N students join the same exam simultaneously, each answers the MC
 * question with a unique free-text response, and all submit. Then:
 *   - No cross-session answer bleed (each student's free-text is unique)
 *   - The teacher's monitor/export reflects exactly N submissions
 *
 * Runs with real browser contexts — keep STUDENT_COUNT conservative
 * (default 3) because real Chromium contexts cost ~150-300 MB each.
 */
test.describe("full lifecycle concurrent", () => {
  let exam: SeededExam
  let teacher: APIRequestContext

  test.beforeAll(async ({ playwright, baseURL }) => {
    teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("stress-t9-teacher")
    await signUp(teacher, { name: "Stress T9 Teacher", email })
    await promoteToTeacher(teacher, { email })
    exam = await createActiveExam(
      teacher,
      `Stress T9 — Concurrent ${Date.now()}`
    )
  })

  test.afterAll(async () => {
    await teacher.dispose()
  })

  test("N concurrent students through full lifecycle with no answer bleed", async ({
    playwright,
    baseURL,
  }) => {
    const students: {
      email: string
      sessionId: string
      uniqueAnswer: string
      page: import("@playwright/test").Page
      browser: import("@playwright/test").Browser
    }[] = []

    // Each student below drives its own dedicated `browser` instance (a
    // separate launched Chromium process with its own CDP connection), not
    // a shared browser/window with multiple tabs. Playwright dispatches
    // input through CDP directly at the target page, not through the OS's
    // window manager, so there is no real cross-page "focus" contention
    // between separate browser instances — a claim the original sequential
    // `for` loops (and their "each browser needs focus" comment) never
    // actually verified. Every phase below is therefore run concurrently
    // via Promise.all; this is also what makes the test worth calling
    // "concurrent" at all, and the submit phase in particular is the one
    // most likely to surface a real bug (duplicate grading, session-lock
    // contention, shared exam-level aggregate updates racing each other).
    // Tracked separately from `students` (which is only populated once ALL
    // joins resolve) so that if one student's join rejects mid-Promise.all,
    // the browsers other students already launched are still closed in the
    // `finally` block below instead of leaking.
    const launchedBrowsers: import("@playwright/test").Browser[] = []

    try {
      async function joinStudent(i: number) {
        const browser = await playwright.chromium.launch()
        launchedBrowsers.push(browser)
        const context = await browser.newContext({ baseURL: baseURL! })
        const page = await context.newPage()

        const email = uniqueEmail(`stress-t9-s${i}`)
        await signUp(page.request, {
          name: `Stress T9 Student ${i}`,
          email,
        })

        await page.goto("/dashboard/student")
        await page.locator("input").fill(exam.accessCode)
        await page.getByRole("button", { name: "Teilnehmen" }).click()
        await page.waitForURL(`**/exam/${exam.id}/take`)

        await expect(
          page.getByText("Was ist die Hauptstadt der Schweiz?")
        ).toBeVisible()

        const sessionsResponse = await page.request.get("/api/sessions")
        expect(sessionsResponse.ok()).toBe(true)
        const ownSessions = (await sessionsResponse.json()).sessions as {
          id: string
          exam: { id: string }
        }[]
        const ownSession = ownSessions.find(
          (session) => session.exam.id === exam.id
        )
        expect(ownSession).toBeTruthy()
        const sessionId = ownSession!.id

        const uniqueText = `Unique answer from student ${i} at ${Date.now()}`
        return { email, sessionId, uniqueAnswer: uniqueText, page, browser }
      }

      const joined = await Promise.all(
        Array.from({ length: STUDENT_COUNT }, (_, i) => joinStudent(i))
      )
      students.push(...joined)

      // Answer uniquely — concurrently across students' independent pages.
      await Promise.all(
        students.map(async ({ page, uniqueAnswer }) => {
          await page.getByText("Bern", { exact: true }).click()
          await page.getByRole("textbox").fill(uniqueAnswer)
          await expect(
            page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
          ).toBeVisible({ timeout: 10000 })
        })
      )

      // Submit all concurrently — the phase most likely to expose a real
      // concurrency bug (e.g. duplicate grading or session-lock
      // contention), since all N submissions now genuinely race each other
      // against the server instead of landing one at a time.
      await Promise.all(
        students.map(async ({ page }) => {
          await page.getByRole("button", { name: "Abgeben" }).click()
          await expect(page.getByText("Prüfung abgeben?")).toBeVisible()
          await page.getByRole("button", { name: "Endgültig abgeben" }).click()
          await page.waitForURL(`**/exam/${exam.id}/complete`)
        })
      )

      // The export contains identities and points; review independently verifies answers.
      const csv = await teacherExportCsv(teacher, exam.id)
      const rows = parseCsv(csv)

      const dataRows = rows.slice(1)
      expect(dataRows.length).toBe(STUDENT_COUNT)

      for (const { email, sessionId, uniqueAnswer } of students) {
        const match = dataRows.find((row) => row[1] === email)
        expect(match, `export should contain ${email}`).toBeTruthy()
        expect(match![2]).toBe("SUBMITTED")
        const reviewResponse = await teacher.get(
          `/api/sessions/${sessionId}/review`
        )
        expect(reviewResponse.ok()).toBe(true)
        const review = await reviewResponse.json()
        expect(review.student.email).toBe(email)
        const answer = review.answers.find(
          (item: { content: { type: string } }) =>
            item.content.type === "FREE_TEXT"
        )
        expect(
          answer?.content.text,
          `${email} persisted answer should match`
        ).toBe(uniqueAnswer)
      }
    } finally {
      for (const browser of launchedBrowsers) {
        await browser.close().catch(() => {})
      }
    }
  })
})
