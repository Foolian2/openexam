import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "./helpers"

/**
 * Accessibility preference settings: toggles persist server-side, apply the
 * matching classes on <html>, and the exam-runner timer can be hidden and
 * peeked while the server-side time limit stays enforced.
 */
test.describe("accessibility settings", () => {
  let exam: SeededExam

  test.beforeAll(async ({ playwright, baseURL }) => {
    const teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("a11y-teacher")
    await signUp(teacher, { name: "E2E Lehrperson", email })
    await promoteToTeacher(teacher, { email })
    exam = await createActiveExam(teacher, `E2E A11y Prüfung ${Date.now()}`)
    await teacher.dispose()
  })

  test("preferences apply classes and persist across reloads", async ({ page }) => {
    await signUp(page.request, {
      name: "E2E A11y Student",
      email: uniqueEmail("a11y-student"),
    })

    await page.goto("/dashboard/student/settings")

    await page.getByLabel("OpenDyslexic-Schriftart").click()
    await page.getByLabel("Hoher Kontrast").click()
    await page.getByLabel("Reduzierte Bewegung").click()

    await expect(page.locator("html")).toHaveClass(/dyslexic/)
    await expect(page.locator("html")).toHaveClass(/high-contrast/)
    await expect(page.locator("html")).toHaveClass(/reduce-motion/)

    // The high-contrast palette must not introduce contrast violations.
    const results = await new AxeBuilder({ page }).analyze()
    expect.soft(results.violations, "a11y violations with high contrast").toEqual([])

    await page.reload()
    await expect(page.getByLabel("OpenDyslexic-Schriftart")).toBeChecked()
    await expect(page.getByLabel("Hoher Kontrast")).toBeChecked()
    await expect(page.getByLabel("Reduzierte Bewegung")).toBeChecked()
  })

  test("hidden exam timer can be peeked while time stays enforced", async ({ page }) => {
    await signUp(page.request, {
      name: "E2E A11y Student 2",
      email: uniqueEmail("a11y-student2"),
    })

    await page.goto("/dashboard/student/settings")
    await page.getByLabel("Prüfungs-Countdown ausblenden").click()
    await expect(page.getByLabel("Prüfungs-Countdown ausblenden")).toBeChecked()

    await page.goto("/dashboard/student")
    // The InputOTP can briefly appear twice during hydration on a fast
    // navigation; both instances drive the same form state.
    await page.getByLabel("Zugangscode").first().fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()

    await page.waitForURL(`**/exam/${exam.id}/take`)
    await expect(page.getByText("Was ist die Hauptstadt der Schweiz?")).toBeVisible()

    // The countdown itself must not be rendered, only the peek control.
    const timerText = /^\d{1,2}:\d{2}(:\d{2})?$/
    await expect(page.getByText(timerText)).toHaveCount(0)
    const peekButton = page.getByRole("button", { name: "Countdown anzeigen" })
    await expect(peekButton).toBeVisible()

    // Peeking reveals the badge; the time limit itself is untouched (server
    // side), so auto-submit and effectiveEndTime still apply.
    await peekButton.click()
    await expect(page.getByText(timerText)).toHaveCount(1)
    await expect(
      page.getByRole("button", { name: "Countdown ausblenden" })
    ).toHaveAttribute("aria-pressed", "true")

    await page.getByRole("button", { name: "Countdown ausblenden" }).click()
    await expect(page.getByText(timerText)).toHaveCount(0)
  })
})
