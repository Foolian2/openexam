import { test, expect } from "@playwright/test"
import { uniqueEmail, signUp, promoteToTeacher, PASSWORD } from "./helpers"

/**
 * Teacher onboarding: the "Erste Schritte" checklist on the teacher
 * dashboard, its dismiss/re-show persistence, progress tracking, and the
 * redirectTo deep-link preservation through login.
 */
test.describe("teacher onboarding", () => {
  test("new teacher sees the checklist and can dismiss and re-show it", async ({
    page,
  }) => {
    const email = uniqueEmail("onboarding-dismiss")
    await signUp(page.request, { name: "E2E Onboarding", email })
    await promoteToTeacher(page.request, { email })

    await page.goto("/dashboard/teacher")

    await expect(
      page.getByRole("heading", { name: "Erste Schritte" })
    ).toBeVisible()
    await expect(page.getByText("0 von 5 Schritten erledigt")).toBeVisible()
    await expect(
      page.getByTestId("onboarding-step-create-exam")
    ).toHaveAttribute("data-done", "false")

    // Dismiss via the footer link; the card disappears and the header shows
    // the re-show button instead.
    await page
      .getByRole("button", { name: "Anleitung ausblenden" })
      .first()
      .click()
    await expect(
      page.getByRole("heading", { name: "Erste Schritte" })
    ).not.toBeVisible()

    const reShow = page.getByRole("button", { name: "Erste Schritte" })
    await expect(reShow).toBeVisible()
    await reShow.click()
    await expect(
      page.getByRole("heading", { name: "Erste Schritte" })
    ).toBeVisible()

    // Dismissal survives a reload (persisted on the user record).
    await page.getByLabel("Anleitung ausblenden").click()
    await expect(
      page.getByRole("heading", { name: "Erste Schritte" })
    ).not.toBeVisible()
    await page.reload()
    await expect(
      page.getByRole("heading", { name: "Erste Schritte" })
    ).not.toBeVisible()
    await expect(
      page.getByRole("button", { name: "Erste Schritte" })
    ).toBeVisible()
  })

  test("creating an exam ticks the first checklist step", async ({ page }) => {
    const email = uniqueEmail("onboarding-progress")
    await signUp(page.request, { name: "E2E Fortschritt", email })
    await promoteToTeacher(page.request, { email })

    await page.goto("/dashboard/teacher")
    await expect(page.getByText("0 von 5 Schritten erledigt")).toBeVisible()

    // Use the checklist's own CTA, which opens the new-exam dialog.
    const stepCta = page
      .getByTestId("onboarding-step-create-exam")
      .getByRole("button", { name: "Prüfung erstellen" })
    await stepCta.click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Titel").fill("E2E Onboarding Prüfung")
    await dialog.getByRole("button", { name: "Prüfung erstellen" }).click()

    // Creation redirects into the exam editor.
    await page.waitForURL("**/dashboard/teacher/exams/*/edit")

    await page.goto("/dashboard/teacher")
    await expect(page.getByText("1 von 5 Schritten erledigt")).toBeVisible()
    await expect(
      page.getByTestId("onboarding-step-create-exam")
    ).toHaveAttribute("data-done", "true")
    // The next open step offers a link into the exam editor.
    await expect(
      page
        .getByTestId("onboarding-step-add-questions")
        .getByRole("link", { name: "Prüfung öffnen" })
    ).toBeVisible()
  })

  test("deep link survives the login redirect", async ({
    page,
    playwright,
    baseURL,
  }) => {
    // Create the teacher in a separate request context so the browser page
    // itself stays signed out.
    const setup = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("onboarding-redirect")
    await signUp(setup, { name: "E2E Redirect", email })
    await promoteToTeacher(setup, { email })
    await setup.dispose()

    await page.goto("/dashboard/teacher/grades")

    // The dashboard layout carries the original path to the login page.
    await page.waitForURL(/\/login\?next=/)
    await expect(page).toHaveURL(/next=%2Fdashboard%2Fteacher%2Fgrades/)

    await page.getByLabel("E-Mail-Adresse").fill(email)
    await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD)
    await page.getByRole("button", { name: "Anmelden", exact: true }).click()

    // After login the user lands back on the originally requested page.
    await page.waitForURL("**/dashboard/teacher/grades")
    await expect(
      page.getByRole("heading", { name: "Bewertungen" })
    ).toBeVisible()
  })

  test("verify-email page offers a resend form", async ({ page }) => {
    await page.goto("/verify-email?email=someone@e2e.test")

    await expect(
      page.getByRole("heading", { name: "E-Mail-Adresse bestätigen" })
    ).toBeVisible()
    const emailInput = page.getByLabel("E-Mail-Adresse")
    await expect(emailInput).toHaveValue("someone@e2e.test")
    await expect(
      page.getByRole("button", { name: "Bestätigungslink erneut senden" })
    ).toBeVisible()
  })
})
