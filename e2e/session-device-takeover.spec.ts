import { test, expect } from "@playwright/test"
import {
  ORIGIN_HEADER,
  PASSWORD,
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
} from "./helpers"

/**
 * One active login per exam session (lib/exam-device.ts): a second login of
 * the same student opening the exam takes it over, the first one is told so
 * and can no longer save, and the teacher's monitor shows the takeover.
 */
test("a second login takes the exam over and the teacher is told", async ({
  browser,
  page,
}) => {
  test.setTimeout(90_000)
  const teacherEmail = uniqueEmail("device-teacher")
  await signUp(page.request, { name: "E2E Lehrperson", email: teacherEmail })
  await promoteToTeacher(page.request, { email: teacherEmail })
  const exam = await createActiveExam(
    page.request,
    `E2E Gerätewechsel ${Date.now()}`
  )

  const studentEmail = uniqueEmail("device-student")
  const first = await browser.newContext()
  const second = await browser.newContext()
  try {
    // Login 1 joins and answers.
    const a = await first.newPage()
    await signUp(a.request, { name: "Gina Geräte", email: studentEmail })
    await a.goto("/dashboard/student")
    await a.getByLabel("Zugangscode").fill(exam.accessCode)
    await a.getByRole("button", { name: "Teilnehmen" }).click()
    await a.waitForURL(`**/exam/${exam.id}/take`)
    // No ws-backend in this suite, so autosave takes the REST path.
    const saved = a.waitForResponse(
      (r) =>
        r.url().endsWith(`/answers`) && r.request().method() === "PUT" && r.ok()
    )
    await a.getByRole("textbox").fill("Antwort vom ersten Gerät")
    await saved

    // Login 2 of the same account opens the same exam.
    const b = await second.newPage()
    const signIn = await b.request.post("/api/auth/sign-in/email", {
      headers: ORIGIN_HEADER,
      data: { email: studentEmail, password: PASSWORD },
    })
    expect(signIn.ok(), `sign-in failed: ${await signIn.text()}`).toBe(true)
    await b.goto(`/exam/${exam.id}/take`)
    await expect(
      b.getByText("Was ist die Hauptstadt der Schweiz?")
    ).toBeVisible()
    await expect(b.getByRole("textbox")).toHaveValue("Antwort vom ersten Gerät")

    // Login 1's next save is refused and it shows the takeover screen.
    await a.getByRole("textbox").fill("Noch eine Antwort vom ersten Gerät")
    await expect(
      a.getByRole("button", { name: "Hier weiterarbeiten" })
    ).toBeVisible({ timeout: 15_000 })

    // Login 2 keeps working.
    await b.getByText("Bern", { exact: true }).click()
    await expect(
      b.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible()

    // The teacher's monitor flags the session.
    await page.goto(`/dashboard/teacher/monitor/${exam.id}`)
    await expect(page.getByText("Gina Geräte").first()).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByText("Weiteres Gerät (1×)").first()).toBeVisible()
  } finally {
    await first.close()
    await second.close()
  }
})

test("two tabs of one login replace and reclaim the same exam", async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000)
  const teacherEmail = uniqueEmail("tab-teacher")
  await signUp(page.request, { name: "E2E Lehrperson", email: teacherEmail })
  await promoteToTeacher(page.request, { email: teacherEmail })
  const exam = await createActiveExam(
    page.request,
    `E2E Tabwechsel ${Date.now()}`
  )

  const student = await browser.newContext()
  try {
    const a = await student.newPage()
    await signUp(a.request, {
      name: "Tina Tabs",
      email: uniqueEmail("tab-student"),
    })
    await a.goto("/dashboard/student")
    await a.getByLabel("Zugangscode").fill(exam.accessCode)
    await a.getByRole("button", { name: "Teilnehmen" }).click()
    await a.waitForURL(`**/exam/${exam.id}/take`)
    await expect(
      a.getByText("Was ist die Hauptstadt der Schweiz?")
    ).toBeVisible()
    const firstId = await a.evaluate(() =>
      sessionStorage.getItem("openexam.examTabId")
    )
    expect(firstId).toBeTruthy()

    // Simulate a browser duplicating sessionStorage into the new tab. Its
    // document must still mint a distinct device identity.
    const b = await student.newPage()
    await b.addInitScript((copiedId) => {
      sessionStorage.setItem("openexam.examTabId", copiedId)
    }, firstId!)
    await b.goto(`/exam/${exam.id}/take`)
    await expect(
      b.getByText("Was ist die Hauptstadt der Schweiz?")
    ).toBeVisible()
    const secondId = await b.evaluate(() =>
      sessionStorage.getItem("openexam.examTabId")
    )
    expect(secondId).toBeTruthy()
    expect(secondId).not.toBe(firstId)

    await a.getByRole("textbox").fill("Antwort aus dem ersten Tab")
    await expect(
      a.getByRole("button", { name: "Hier weiterarbeiten" })
    ).toBeVisible({ timeout: 20_000 })
    const bSaved = b.waitForResponse(
      (r) =>
        r.url().endsWith("/answers") && r.request().method() === "PUT" && r.ok()
    )
    await b.getByRole("textbox").fill("Antwort aus dem zweiten Tab")
    await bSaved

    await a.getByRole("button", { name: "Hier weiterarbeiten" }).click()
    await expect(
      a.getByText("Was ist die Hauptstadt der Schweiz?")
    ).toBeVisible()
    await b.getByRole("textbox").fill("Alter Tab speichert erneut")
    await expect(
      b.getByRole("button", { name: "Hier weiterarbeiten" })
    ).toBeVisible({ timeout: 20_000 })
    const aSaved = a.waitForResponse(
      (r) =>
        r.url().endsWith("/answers") && r.request().method() === "PUT" && r.ok()
    )
    await a.getByRole("textbox").fill("Zurück im ersten Tab")
    await aSaved

    await page.goto(`/dashboard/teacher/monitor/${exam.id}`)
    await expect(page.getByText("Tina Tabs").first()).toBeVisible()
    await expect(page.getByText("Weiteres Gerät (2×)").first()).toBeVisible()
  } finally {
    await student.close()
  }
})
