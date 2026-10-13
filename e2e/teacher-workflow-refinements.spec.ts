import { expect, test } from "@playwright/test"

import {
  createActiveExam,
  promoteToTeacher,
  signUp,
  uniqueEmail,
} from "./helpers"

const BASE_URL =
  process.env.E2E_BASE_URL ??
  process.env.TARGET_BASE_URL ??
  `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
const origin = new URL(BASE_URL).origin

test("teacher can triage the monitor and grade submissions in sequence", async ({
  page,
  playwright,
}) => {
  test.setTimeout(120_000)
  const teacherEmail = uniqueEmail("teacher-workflow")
  await signUp(page.request, {
    name: "Workflow Teacher",
    email: teacherEmail,
  })
  await promoteToTeacher(page.request, { email: teacherEmail })
  const exam = await createActiveExam(
    page.request,
    `Teacher Workflow ${Date.now()}`
  )

  const students = await Promise.all(
    [
      { name: "Anna Attention", email: uniqueEmail("monitor-attention") },
      { name: "Berta Regular", email: uniqueEmail("monitor-regular") },
    ].map(async (student) => {
      const request = await playwright.request.newContext({
        baseURL: BASE_URL,
      })
      await signUp(request, student)
      const joinResponse = await request.post("/api/sessions", {
        headers: { origin },
        data: { accessCode: exam.accessCode },
      })
      expect(
        joinResponse.ok(),
        `join failed: ${joinResponse.status()} ${await joinResponse.text()}`
      ).toBe(true)
      const { sessionId } = (await joinResponse.json()) as {
        sessionId: string
      }
      return { ...student, request, sessionId }
    })
  )

  try {
    const attentionSession = students[0]
    const lockResponse = await page.request.post(
      `/api/sessions/${attentionSession.sessionId}/lock`,
      { data: { locked: true } }
    )
    expect(lockResponse.ok(), await lockResponse.text()).toBe(true)

    await page.goto(`/dashboard/teacher/monitor/${exam.id}`)

    await expect(
      page.getByRole("button", {
        name: `Zugangscode ${exam.accessCode} kopieren`,
      })
    ).toBeVisible()
    await expect(
      page.getByText("Benötigt Aufmerksamkeit").first()
    ).toBeVisible()
    await expect(page.getByText("Weitere Teilnehmende").first()).toBeVisible()
    await expect(page.getByText("Anna Attention").first()).toBeVisible()
    await expect(page.getByText("Berta Regular").first()).toBeVisible()
    await expect(
      page
        .getByText(/Live verbunden|Intervall-Aktualisierung|Daten veraltet/)
        .first()
    ).toBeVisible()

    await page.getByRole("button", { name: "Code anzeigen" }).click()
    await expect(page.getByRole("dialog")).toContainText(exam.accessCode)
    await page.keyboard.press("Escape")

    await page.route(
      `**/api/sessions/${attentionSession.sessionId}/extend`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 350))
        await route.continue()
      }
    )
    const attentionRow = page
      .getByRole("row")
      .filter({ hasText: "Anna Attention" })
    // Matches the "not yet granted" aria-label by its stable prefix. The full
    // label is a descriptive sentence that has already been reworded once
    // without this locator following it; anchoring on the colon also
    // keeps it from matching the "bereits gewährt" state asserted below.
    const accommodation = attentionRow.getByRole("button", {
      name: /^Nachteilsausgleich:/,
    })
    await accommodation.click()
    await expect(accommodation).toBeDisabled()
    await expect(
      attentionRow.getByRole("button", {
        name: "Nachteilsausgleich bereits gewährt",
      })
    ).toBeDisabled()
    await expect(attentionRow.getByText("NAM gewährt")).toBeVisible()

    await page.route(
      `**/api/sessions/${attentionSession.sessionId}/lock`,
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 350))
        await route.continue()
      }
    )
    const unlockButton = attentionRow.getByRole("button", {
      name: "Entsperren",
    })
    await unlockButton.click()
    await expect(unlockButton).toBeDisabled()
    await expect(
      attentionRow.getByRole("button", { name: "Sperren" })
    ).toBeEnabled()

    await attentionRow.getByRole("button", { name: "Zeit verlängern" }).click()
    await page.getByLabel("Minuten").fill("10")
    const extendButton = page.getByRole("button", { name: "Verlängern" })
    await extendButton.click()
    await expect(extendButton).toBeDisabled()
    await expect(page.getByRole("dialog")).toBeHidden()
    await expect(page.getByText(/^[+]\d+ Min[.]$/).first()).toBeVisible()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      page.locator("article").filter({ hasText: "Anna Attention" })
    ).toBeVisible()
    await expect(page.locator("table")).toBeHidden()

    const closeResponse = await page.request.post(`/api/exams/${exam.id}/close`)
    expect(closeResponse.ok(), await closeResponse.text()).toBe(true)

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(
      `/dashboard/teacher/grades/${exam.id}/${attentionSession.sessionId}`
    )
    await expect(page.getByText("1 von 2 Fragen offen")).toBeVisible()
    await page.getByRole("spinbutton").nth(1).fill("2")
    await page.getByRole("button", { name: "Speichern & weiter" }).click()
    await expect(page).toHaveURL(
      `/dashboard/teacher/grades/${exam.id}/${students[1].sessionId}`
    )
    await expect(
      page.getByRole("heading", { name: "Berta Regular" })
    ).toBeVisible()
  } finally {
    await Promise.all(students.map((student) => student.request.dispose()))
  }
})
