import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { uniqueEmail, PASSWORD } from "./helpers"

test("student can register and log in through the UI", async ({ page }) => {
  const email = uniqueEmail("auth-student")

  await page.goto("/register")

  const registerResults = await new AxeBuilder({ page }).analyze()
  expect.soft(registerResults.violations, "a11y violations on /register").toEqual(
    []
  )

  await page.getByLabel("Name").fill("E2E Studentin")
  await page.getByLabel("E-Mail-Adresse").fill(email)
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD)
  await page.getByLabel("Passwort bestätigen").fill(PASSWORD)

  // Without the Datenschutzerklärung acknowledgement the form refuses.
  await page.getByRole("button", { name: "Registrieren" }).click()
  await expect(
    page.getByText(
      "Bitte bestätigen Sie, dass Sie die Datenschutzerklärung gelesen haben."
    )
  ).toBeVisible()

  await page
    .getByRole("checkbox", { name: /Datenschutzerklärung gelesen/ })
    .check()
  await page.getByRole("button", { name: "Registrieren" }).click()

  await expect(page.getByText("Konto erstellt")).toBeVisible()
  await page.getByRole("link", { name: "Zur Anmeldung" }).click()

  await page.getByLabel("E-Mail-Adresse").fill(email)
  await page.getByLabel("Passwort", { exact: true }).fill(PASSWORD)
  await page.getByRole("button", { name: "Anmelden", exact: true }).click()

  // New accounts default to STUDENT and land on the student dashboard, via a
  // server-side redirect chain (/dashboard -> /dashboard/student). Wait for
  // the final page's content before scanning, so axe doesn't catch an
  // intermediate redirect hop instead of the settled page.
  await page.waitForURL("**/dashboard/**")
  await expect(page.getByText("An Prüfung teilnehmen")).toBeVisible()

  const dashboardResults = await new AxeBuilder({ page }).analyze()
  expect
    .soft(dashboardResults.violations, "a11y violations on /dashboard")
    .toEqual([])
})

for (const { path, heading, section } of [
  {
    path: "/datenschutz",
    heading: "Datenschutzerklärung",
    section: "Verantwortliche Stelle",
  },
  { path: "/impressum", heading: "Impressum", section: "Betreiberin" },
]) {
  test(`${path} is readable without an account`, async ({ page }) => {
    await page.goto(path)
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(
      page.getByRole("heading", { level: 1, name: heading })
    ).toBeVisible()
    await expect(page.getByRole("heading", { name: section })).toBeVisible()

    const results = await new AxeBuilder({ page }).analyze()
    expect.soft(results.violations, `a11y violations on ${path}`).toEqual([])
  })
}

test("/datenschutz lists the session cookie", async ({ page }) => {
  await page.goto("/datenschutz#cookies")
  await expect(
    page.getByRole("heading", { name: "Cookies und lokaler Speicher" })
  ).toBeVisible()
  await expect(
    page.getByText("better-auth.session_token", { exact: true })
  ).toBeVisible()
})

test("login with a wrong password shows an error and no session", async ({ page }) => {
  await page.goto("/login")

  const loginResults = await new AxeBuilder({ page }).analyze()
  expect.soft(loginResults.violations, "a11y violations on /login").toEqual([])

  await page.getByLabel("E-Mail-Adresse").fill(uniqueEmail("auth-nobody"))
  await page.getByLabel("Passwort", { exact: true }).fill("falsches-passwort-123")
  await page.getByRole("button", { name: "Anmelden", exact: true }).click()

  await expect(page).toHaveURL(/\/login/)
})
