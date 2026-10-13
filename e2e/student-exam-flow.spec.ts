import { test, expect } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "./helpers"

/**
 * The core happy path: a teacher prepares and activates an exam (via the
 * REST API), then a student joins with the access code, answers through the
 * real UI with autosave, and submits.
 */
test.describe("student exam flow", () => {
  let exam: SeededExam

  test.beforeAll(async ({ playwright, baseURL }) => {
    const teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("flow-teacher")
    await signUp(teacher, { name: "E2E Lehrperson", email })
    await promoteToTeacher(teacher, { email })
    exam = await createActiveExam(teacher, `E2E Prüfung ${Date.now()}`)
    await teacher.dispose()
  })

  test("student joins with access code, answers, and submits", async ({ page }) => {
    // Sign up through the API into the browser context's cookie jar.
    await signUp(page.request, {
      name: "E2E Student",
      email: uniqueEmail("flow-student"),
    })

    await page.goto("/dashboard/student")
    await page.getByLabel("Zugangscode").fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()

    await page.waitForURL(`**/exam/${exam.id}/take`)
    await expect(page.getByText("Was ist die Hauptstadt der Schweiz?")).toBeVisible()

    // Answer the multiple-choice question.
    await page.getByText("Bern", { exact: true }).click()
    // Answer the free-text question.
    await page.getByRole("textbox").fill("Bern ist die Bundesstadt der Schweiz.")

    // Autosave (debounced) should confirm both answers before submitting.
    // Scoped to the banner: the same counter also appears in the
    // Fragenübersicht rail, so an unscoped getByText is ambiguous.
    await expect(
      page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible()

    await page.getByRole("button", { name: "Abgeben" }).click()
    await expect(page.getByText("Prüfung abgeben?")).toBeVisible()
    // No required questions may be flagged as unanswered.
    await expect(page.getByText("Pflichtfrage(n) unbeantwortet")).not.toBeVisible()
    await page.getByRole("button", { name: "Endgültig abgeben" }).click()

    await page.waitForURL(`**/exam/${exam.id}/complete`)

    // Re-entering the same access code must not restart the exam.
    await page.goto("/dashboard/student")
    await page.getByLabel("Zugangscode").fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await expect(page).not.toHaveURL(new RegExp(`/exam/${exam.id}/take$`))
  })

  test("joining with an invalid access code shows an error", async ({ page }) => {
    await signUp(page.request, {
      name: "E2E Student 2",
      email: uniqueEmail("flow-student2"),
    })

    await page.goto("/dashboard/student")
    await page.getByLabel("Zugangscode").fill("XXXXXX")
    await page.getByRole("button", { name: "Teilnehmen" }).click()

    await expect(page).toHaveURL(/\/dashboard\/student/)
    await expect(page.locator("form .text-destructive")).toBeVisible()
  })
})
