import { test, expect } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "./helpers"

/**
 * The exam runner's settings menu (gear icon) applies display preferences
 * for the current session only: dark/light theme, text size, dyslexic font,
 * high contrast and hiding the countdown. None of them may persist — the
 * student's saved settings on /dashboard/student/settings stay untouched and
 * everything reverts when the exam is left.
 */
test.describe("exam runner temporary settings menu", () => {
  let exam: SeededExam

  test.beforeAll(async ({ playwright, baseURL }) => {
    const teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("menu-teacher")
    await signUp(teacher, { name: "E2E Lehrperson", email })
    await promoteToTeacher(teacher, { email })
    exam = await createActiveExam(teacher, `E2E Menu Prüfung ${Date.now()}`)
    await teacher.dispose()
  })

  test("settings apply in the exam, revert after leaving, and never persist", async ({
    page,
  }) => {
    await signUp(page.request, {
      name: "E2E Menu Student",
      email: uniqueEmail("menu-student"),
    })

    await page.goto("/dashboard/student")
    const html = page.locator("html")
    const baselineClasses = (await html.getAttribute("class")) ?? ""

    await page.getByLabel("Zugangscode").first().fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${exam.id}/take`)
    await expect(page.getByText("Was ist die Hauptstadt der Schweiz?")).toBeVisible()

    await page.getByRole("button", { name: "Einstellungen" }).click()

    // Dyslexic font and high contrast apply their classes on <html>.
    await page.getByLabel("OpenDyslexic-Schriftart").click()
    await page.getByLabel("Hoher Kontrast").click()
    await expect(html).toHaveClass(/dyslexic/)
    await expect(html).toHaveClass(/high-contrast/)

    // Large text scales the root rem unit.
    await page.getByRole("button", { name: "Groß" }).click()
    await expect(html).toHaveCSS("font-size", "18px")

    // Dark theme is applied to the document.
    await page.getByRole("button", { name: "Dunkel" }).click()
    await expect(html).toHaveClass(/dark/)

    // Hiding the countdown removes the badge but keeps the peek control.
    await page.getByLabel("Countdown ausblenden").click()
    const timerText = /^\d{1,2}:\d{2}(:\d{2})?$/
    await expect(page.getByText(timerText)).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Countdown anzeigen" })).toBeVisible()

    // Leaving the exam reverts theme, classes and text size.
    await page.goto("/dashboard/student")
    await expect(html).toHaveClass(baselineClasses)
    await expect(html).not.toHaveCSS("font-size", "18px")

    // Nothing was persisted to the account: saved settings are still off.
    await page.goto("/dashboard/student/settings")
    await expect(page.getByLabel("OpenDyslexic-Schriftart")).not.toBeChecked()
    await expect(page.getByLabel("Hoher Kontrast")).not.toBeChecked()
    await expect(page.getByLabel("Prüfungs-Countdown ausblenden")).not.toBeChecked()
  })
})
