import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { uniqueEmail } from "./helpers"

// The token round-trip (mail -> reset -> sign-in) needs a mailbox, which CI
// doesn't have; it is covered by the unit tests in
// __tests__/password-reset.test.ts. These cover the pages themselves.

test("login links to a reset request that never reveals whether an account exists", async ({
  page,
}) => {
  await page.goto("/login")
  await page.getByRole("link", { name: "Passwort vergessen?" }).click()
  await expect(page).toHaveURL(/\/forgot-password$/)

  const results = await new AxeBuilder({ page }).analyze()
  expect
    .soft(results.violations, "a11y violations on /forgot-password")
    .toEqual([])

  await page.getByLabel("E-Mail-Adresse").fill(uniqueEmail("reset-nobody"))
  await page.getByRole("button", { name: "Link senden" }).click()
  await expect(
    page.getByText("Falls ein Konto mit dieser E-Mail-Adresse existiert")
  ).toBeVisible()
})

test("an invalid reset link is refused and the token leaves the address bar", async ({
  page,
}) => {
  await page.goto("/reset-password?token=not-a-real-token")
  // The page drops the token from the URL (and history) once it has it.
  await expect(page).toHaveURL(/\/reset-password$/)

  const results = await new AxeBuilder({ page }).analyze()
  expect
    .soft(results.violations, "a11y violations on /reset-password")
    .toEqual([])

  await page.getByLabel("Neues Passwort").fill("ein-neues-Passwort-1")
  await page.getByLabel("Passwort bestätigen").fill("ein-neues-Passwort-1")
  await page.getByRole("button", { name: "Passwort speichern" }).click()
  await expect(
    page.getByText("Der Link ist ungültig oder abgelaufen")
  ).toBeVisible()
})

test("a reset page opened without a token offers a new link", async ({
  page,
}) => {
  await page.goto("/reset-password?error=INVALID_TOKEN")
  await expect(
    page.getByText("Der Link ist ungültig oder abgelaufen")
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Passwort speichern" })
  ).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "Neuen Link anfordern" })
  ).toBeVisible()
})
