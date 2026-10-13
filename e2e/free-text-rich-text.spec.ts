import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test"
import { uniqueEmail, signUp, promoteToTeacher, PASSWORD } from "./helpers"

/**
 * Rich text for FREE_TEXT questions (config.richText): the student sees a
 * real formatting editor with a character counter, the formatted answer
 * survives the autosave round-trip, grading renders it sanitized, and
 * expected keywords are highlighted during manual grading.
 */
test.describe("free-text rich text", () => {
  // The shared IP-keyed auth rate limit (helpers retry on 429 with the
  // server's X-Retry-After) can swallow several full reset windows across
  // sign-up/sign-in calls, so this suite gets a much longer budget than the
  // default 30s (applies to tests and beforeAll/afterAll hooks alike).
  test.describe.configure({ timeout: 180_000 })

  let examId: string
  let accessCode: string
  let teacherContext: APIRequestContext
  let teacherEmail: string
  let questionId: string

  test.beforeAll(async ({ playwright, baseURL }) => {
    teacherContext = await playwright.request.newContext({ baseURL })
    teacherEmail = uniqueEmail("rt-teacher")
    await signUp(teacherContext, { name: "RT Lehrperson", email: teacherEmail })
    await promoteToTeacher(teacherContext, { email: teacherEmail })

    const createRes = await teacherContext.post("/api/exams", {
      data: { title: `RT Prüfung ${Date.now()}`, timeLimitMin: 30 },
    })
    expect(createRes.ok()).toBe(true)
    const { exam } = await createRes.json()
    examId = exam.id
    accessCode = exam.accessCode

    const qRes = await teacherContext.post(`/api/exams/${examId}/questions`, {
      data: {
        title: "Begründe die Rolle der Bundesstadt.",
        points: 5,
        required: true,
        type: "FREE_TEXT",
        config: {
          maxLength: 1000,
          richText: true,
          expectedKeywords: ["Bundesstadt", "Schweiz"],
        },
      },
    })
    expect(qRes.ok(), `question failed: ${await qRes.text()}`).toBe(true)
    questionId = (await qRes.json()).question.id

    const publishRes = await teacherContext.post(`/api/exams/${examId}/publish`)
    expect(publishRes.ok(), `publish failed: ${await publishRes.text()}`).toBe(
      true
    )
    const activateRes = await teacherContext.post(
      `/api/exams/${examId}/activate`
    )
    expect(
      activateRes.ok(),
      `activate failed: ${await activateRes.text()}`
    ).toBe(true)
  })

  test.afterAll(async () => {
    await teacherContext?.dispose()
  })

  test("student formats an answer that renders with highlighted keywords in grading", async ({
    page,
  }) => {
    const studentEmail = uniqueEmail("rt-student")
    await signUp(page.request, { name: "RT Student", email: studentEmail })

    await page.goto("/dashboard/student")
    await page.getByLabel("Zugangscode").fill(accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${examId}/take`)

    // The rich-text editor (toolbar + editable area) replaces the plain input.
    await expect(
      page.getByRole("toolbar", { name: "Formatierung" })
    ).toBeVisible()
    const editor = page.getByRole("textbox")
    await expect(editor).toBeVisible()
    await expect(page.getByText("0 / 1000")).toBeVisible()

    // Type "Die Bundesstadt der Schweiz ist Bern." with "Bundesstadt" bold.
    const parts = ["Die ", "Bundesstadt", " der Schweiz ist Bern."]
    const boldWord = parts[1]
    await editor.click()
    await editor.pressSequentially(parts[0])
    await page.getByRole("button", { name: "Fett" }).click()
    await editor.pressSequentially(boldWord)
    await page.getByRole("button", { name: "Fett" }).click()
    await editor.pressSequentially(parts[2])

    const total = parts.join("").length
    await expect(page.getByText(`${total} / 1000`)).toBeVisible()
    await expect(editor.locator("strong", { hasText: boldWord })).toBeVisible()

    // Autosave persists; a reload restores the formatted answer. Scoped to
    // the banner: the same counter also appears in the Fragenübersicht rail.
    await expect(
      page.getByRole("banner").getByText("1 von 1 Fragen beantwortet")
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole("textbox").locator("strong", { hasText: boldWord })
    ).toBeVisible()

    await page.getByRole("button", { name: "Abgeben" }).click()
    await expect(page.getByText("Prüfung abgeben?")).toBeVisible()
    await page.getByRole("button", { name: "Endgültig abgeben" }).click()
    await page.waitForURL(`**/exam/${examId}/complete`)

    // Teacher grades the submission (browser is signed in as the student,
    // so switch to the teacher session first).
    await signInAsTeacher(page)
    const sessionId = await findSessionId(studentEmail)
    await page.goto(`/dashboard/teacher/grades/${examId}/${sessionId}`)

    // Formatted answer renders as HTML, keywords are highlighted with <mark>.
    await expect(page.locator("strong", { hasText: boldWord })).toBeVisible()
    await expect(page.locator("mark", { hasText: "Bundesstadt" })).toHaveCount(
      1
    )
    await expect(page.locator("mark", { hasText: "Schweiz" })).toHaveCount(1)
  })

  test("hostile markup in an answer is never executed in the grading view", async ({
    page,
  }) => {
    const studentEmail = uniqueEmail("rt-student-xss")
    await signUp(page.request, { name: "RT Student XSS", email: studentEmail })

    await page.goto("/dashboard/student")
    await page.getByLabel("Zugangscode").fill(accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${examId}/take`)

    // The editor itself escapes markup typed by the student.
    const editor = page.getByRole("textbox")
    await editor.click()
    await editor.pressSequentially(
      "<img src=x onerror=\"document.body.setAttribute('data-xss','1')\">Bern ist die Bundesstadt."
    )
    await expect(
      page.getByRole("banner").getByText("1 von 1 Fragen beantwortet")
    ).toBeVisible()
    await page.reload()

    // Push an unsanitized payload through the autosave API to prove the
    // grading view sanitizes at render time, not only at edit time. No
    // reload afterwards: the editor would re-parse (and strip) the payload.
    const mySessions = await page.request.get("/api/sessions")
    expect(mySessions.ok()).toBe(true)
    const list = (await mySessions.json()).sessions as {
      id: string
      exam: { id: string }
    }[]
    const mine = list.find((s) => s.exam.id === examId)
    expect(mine).toBeTruthy()
    const deviceId = await page.evaluate(() =>
      sessionStorage.getItem("openexam.examTabId")
    )
    expect(deviceId).toBeTruthy()
    const put = await page.request.put(`/api/sessions/${mine!.id}/answers`, {
      headers: { "x-openexam-device-id": deviceId! },
      data: {
        questionId,
        content: {
          type: "FREE_TEXT",
          text: "<img src=x onerror=\"document.body.setAttribute('data-xss','1')\"><script>window.__xss = 1</script>Bern ist die Bundesstadt.",
        },
      },
    })
    expect(put.ok(), `autosave failed: ${await put.text()}`).toBe(true)

    await page.getByRole("button", { name: "Abgeben" }).click()
    await page.getByRole("button", { name: "Endgültig abgeben" }).click()
    await page.waitForURL(`**/exam/${examId}/complete`)

    const sessionId = await findSessionId(studentEmail)
    await signInAsTeacher(page)
    await page.goto(`/dashboard/teacher/grades/${examId}/${sessionId}`)

    await expect(page.getByText("Bern ist die Bundesstadt.")).toBeVisible()
    const answerArea = page.locator(".rich-text-content")
    await expect(answerArea.locator("img")).toHaveCount(0)
    await expect(answerArea.locator("script")).toHaveCount(0)
    await expect(page.locator("body")).not.toHaveAttribute("data-xss", "1")
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __xss?: number }).__xss)
      )
      .toBe(undefined)
  })

  /** Looks up the student's exam session id via the teacher API. */
  async function findSessionId(studentEmail: string): Promise<string> {
    const res = await teacherContext.get(`/api/exams/${examId}/sessions`)
    expect(res.ok(), `sessions failed: ${await res.text()}`).toBe(true)
    const { sessions } = await res.json()
    const mine = sessions.find(
      (s: { student: { email: string } }) => s.student.email === studentEmail
    )
    expect(mine, "student session not found").toBeTruthy()
    return mine!.id
  }

  /**
   * Signs the browser context out and back in as the teacher, so the
   * grading page (TEACHER-only) can be opened in the same browser.
   */
  async function signInAsTeacher(page: Page): Promise<void> {
    const baseURL = new URL(page.url()).origin
    const headers = { origin: baseURL }
    const out = await page.request.post("/api/auth/sign-out", {
      headers,
      data: {},
    })
    expect(out.ok(), `sign-out failed: ${await out.text()}`).toBe(true)

    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await page.request.post("/api/auth/sign-in/email", {
        headers,
        data: { email: teacherEmail, password: PASSWORD },
      })
      if (res.ok()) return
      if (res.status() === 429) {
        await page.waitForTimeout(15_000)
        continue
      }
      expect(res.ok(), `teacher sign-in failed: ${await res.text()}`).toBe(true)
    }
    throw new Error("teacher sign-in kept hitting the rate limiter")
  }
})
