import { test, expect } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "./helpers"

/**
 * Mobile (375×667) coverage of the student surfaces: the dashboard renders
 * session cards instead of a scrollable table, and the exam runner moves
 * "Abgeben" into a fixed bottom bar with the accessibility toggles tucked
 * behind a settings menu — the whole flow must stay usable on a phone.
 * The desktop header layout is covered by student-exam-flow.spec.ts.
 */
test.describe("mobile student UI", () => {
  test.use({ viewport: { width: 375, height: 667 } })

  let exam: SeededExam
  let examTitle: string

  test.beforeAll(async ({ playwright, baseURL }) => {
    const teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("mobile-teacher")
    await signUp(teacher, { name: "E2E Lehrperson", email })
    await promoteToTeacher(teacher, { email })
    examTitle = `E2E Mobile ${Date.now()}`
    exam = await createActiveExam(teacher, examTitle)
    await teacher.dispose()
  })

  test("student joins an exam on a mobile viewport", async ({ page }) => {
    await signUp(page.request, {
      name: "E2E Student",
      email: uniqueEmail("mobile-student"),
    })

    await page.goto("/dashboard/student")

    // The desktop table must not render at a mobile viewport.
    await expect(page.getByRole("table")).toHaveCount(0)

    // The join card remains centered and usable.
    await page.getByLabel("Zugangscode").fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${exam.id}/take`)
    await expect(page.getByText("Was ist die Hauptstadt der Schweiz?")).toBeVisible()
  })

  test("exam runner shows bottom submit bar and settings menu", async ({ page }) => {
    await signUp(page.request, {
      name: "E2E Student 2",
      email: uniqueEmail("mobile-student2"),
    })

    await page.goto("/dashboard/student")
    await page.getByLabel("Zugangscode").fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${exam.id}/take`)

    await page.getByText("Bern", { exact: true }).click()
    await page.getByRole("textbox").fill("Bern ist die Bundesstadt der Schweiz.")
    // Scoped to the banner: the same counter also appears in the
    // Fragenübersicht rail, so an unscoped getByText is ambiguous.
    await expect(
      page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible()

    // Accessibility toggles are hidden behind the settings menu on mobile.
    await page.getByRole("button", { name: "Einstellungen" }).click()
    await expect(page.getByText("OpenDyslexic-Schriftart")).toBeVisible()
    await expect(page.getByText("Design")).toBeVisible()
    await page.keyboard.press("Escape")

    // Submit happens through the fixed bottom bar on mobile.
    await page.getByRole("button", { name: "Abgeben" }).click()
    await expect(page.getByText("Prüfung abgeben?")).toBeVisible()
    await page.getByRole("button", { name: "Endgültig abgeben" }).click()
    await page.waitForURL(`**/exam/${exam.id}/complete`)

    // The submitted session shows up as a card on the mobile dashboard.
    // getByText matches hidden elements too, so target the card's paragraph
    // and scope the badge lookup to its card — the desktop table stays in the
    // DOM (hidden) and would otherwise produce strict-mode collisions.
    await page.goto("/dashboard/student")
    await expect(page.getByRole("table")).toHaveCount(0)
    const cardTitle = page.getByRole("paragraph").filter({ hasText: examTitle })
    await expect(cardTitle).toBeVisible()
    await expect(cardTitle.locator("..").getByText("Abgegeben")).toBeVisible()
  })
})
