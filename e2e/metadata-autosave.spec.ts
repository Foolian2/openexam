import { expect, test, type Route } from "@playwright/test"
import { promoteToTeacher, signUp, uniqueEmail } from "./helpers"

test("metadata keeps the newest SEB toggle and shows rejected saves", async ({
  page,
}, testInfo) => {
  const email = uniqueEmail("metadata-save")
  await signUp(page.request, { name: "Metadata Teacher", email })
  await promoteToTeacher(page.request, { email })
  const created = await page.request.post("/api/exams", {
    data: { title: "Metadata before", timeLimitMin: 60 },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { exam } = await created.json()
  const stored = async () => {
    const res = await page.request.get(`/api/exams/${exam.id}`)
    const { exam: saved } = await res.json()
    return { title: saved.title, sebRequired: saved.sebRequired }
  }
  const patchBodies: Array<{ title?: string; sebRequired?: boolean }> = []
  page.on("request", (request) => {
    if (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === `/api/exams/${exam.id}`
    ) {
      patchBodies.push(request.postDataJSON())
    }
  })
  try {
    await page.goto(`/dashboard/teacher/exams/${exam.id}/edit`)
    // A click that lands before hydration is lost (same guard as
    // waiting-room.spec.ts).
    await page.waitForLoadState("networkidle")
    const saveStatus = page.getByTestId("metadata-save-status")
    await page.getByLabel(/Titel/).fill("Metadata after")
    await page.getByRole("switch", { name: /Safe Exam Browser/ }).click()
    await expect(saveStatus).toHaveText("Gespeichert")
    // The title snapshot may still sit in its 600 ms debounce when the
    // switch saves, or lose the race and land after it — both are correct,
    // so assert the PATCH bodies and their order instead of a request count
    // tied to runner speed: the newest state wins and nothing may revert SEB
    // once it is on. A debounce that must not happen is only provable by
    // waiting that window out.
    await page.waitForTimeout(700)
    expect(patchBodies.length).toBeLessThanOrEqual(2)
    const sebFlags = patchBodies.map((body) => body.sebRequired)
    const firstSebOn = sebFlags.indexOf(true)
    expect(firstSebOn).toBeGreaterThanOrEqual(0)
    expect(sebFlags.slice(firstSebOn + 1)).not.toContain(false)
    expect(patchBodies.at(-1)).toMatchObject({
      title: "Metadata after",
      sebRequired: true,
    })
    await expect.poll(stored).toEqual({
      title: "Metadata after",
      sebRequired: true,
    })

    const rejectMetadataPatch = async (route: Route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "CONFLICT", message: "Test rejected save" },
          }),
        })
      } else await route.continue()
    }
    await page.route(`**/api/exams/${exam.id}`, rejectMetadataPatch)
    await page.getByLabel(/Titel/).fill("Rejected edit")
    // Scoped to the inline indicator: the error toast can carry the same
    // German text, and matching both would trip strict mode.
    await expect(saveStatus).toHaveText("Fehler beim Speichern")
    await testInfo.attach("metadata save error", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    })

    // A later successful edit must clear the stale error indicator.
    await page.unroute(`**/api/exams/${exam.id}`, rejectMetadataPatch)
    await page.getByLabel(/Titel/).fill("Recovered edit")
    await expect(saveStatus).toHaveText("Gespeichert")
    await expect.poll(stored).toEqual({
      title: "Recovered edit",
      sebRequired: true,
    })
  } finally {
    await page.request.delete(`/api/exams/${exam.id}`)
  }
})
