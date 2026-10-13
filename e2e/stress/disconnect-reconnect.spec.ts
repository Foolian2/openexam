import { test, expect } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "./helpers"

/**
 * T2 — Disconnect / reconnect during an exam.
 *
 * A student joins an exam, answers the MC question online (establishing a
 * clean baseline), then loses connectivity (goes offline) and edits the
 * free-text answer WHILE still offline — this is the actual behavior under
 * test: an edit made during the outage, not one saved before it. On
 * reconnect, that offline edit must sync to the server (not be lost), and
 * the timer must not have reset.
 */
test.describe("disconnect / reconnect", () => {
  let exam: SeededExam

  test.beforeAll(async ({ playwright, baseURL }) => {
    const teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("stress-t2-teacher")
    await signUp(teacher, { name: "Stress T2 Teacher", email })
    await promoteToTeacher(teacher, { email })
    exam = await createActiveExam(
      teacher,
      `Stress T2 — Disconnect ${Date.now()}`
    )
    await teacher.dispose()
  })

  test("edits made while offline sync to the server on reconnect", async ({
    page,
  }) => {
    await signUp(page.request, {
      name: "Stress T2 Student",
      email: uniqueEmail("stress-t2-student"),
    })

    await page.goto("/dashboard/student")
    await page.locator("input").fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${exam.id}/take`)

    await expect(
      page.getByText("Was ist die Hauptstadt der Schweiz?")
    ).toBeVisible()

    // TimerBadge renders MM:SS and only prefixes hours when ≥ 1h remains,
    // so a 30-minute exam shows e.g. "29:59" — the regex must allow both.
    const timerLocator = page
      .locator("header")
      .getByText(/\d{1,2}:\d{2}(:\d{2})?/)
    const preText = await timerLocator.textContent()
    expect(preText).toMatch(/\d/)

    const mcCard = page
      .locator("[data-question-id]")
      .filter({ hasText: "Was ist die Hauptstadt der Schweiz?" })
    const freeTextCard = page
      .locator("[data-question-id]")
      .filter({ hasText: "Begründe deine Antwort." })

    // Baseline: answer the MC question online and let it sync (the
    // SaveIndicator's CheckCircle2 — see components/exam-taking/exam-runner.tsx
    // — flips to green once saved) before the outage starts, so the offline
    // edit below is unambiguously the thing under test, not a leftover from
    // before going offline.
    await mcCard.getByText("Bern", { exact: true }).click()
    await expect(
      page.getByRole("banner").getByText("1 von 2 Fragen beantwortet")
    ).toBeVisible({ timeout: 5000 })
    await expect(mcCard.locator("svg.text-green-600")).toBeVisible({
      timeout: 10000,
    })

    await page.context().setOffline(true)

    // The real behavior under test: change the free-text answer WHILE the
    // page is offline.
    const offlineAnswer = `Offline edit at ${Date.now()}`
    await freeTextCard.getByRole("textbox").fill(offlineAnswer)
    await expect(
      page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible()

    // The debounced autosave (see ExamRunner.saveAnswer) tries the WebSocket
    // first, then falls back to REST — both are unreachable while offline —
    // so the SaveIndicator should flip to its "error" state (AlertTriangle)
    // rather than silently doing nothing. This confirms the edit is really
    // buffered against a live, currently-failing save path.
    await expect(freeTextCard.locator("svg.text-amber-500")).toBeVisible({
      timeout: 8000,
    })

    await page.context().setOffline(false)

    // Proper wait condition instead of a fixed sleep: wait for the
    // SaveIndicator to flip back to "saved" (CheckCircle2), which only
    // happens once the buffered offline edit has actually round-tripped to
    // the server — via the WS reconnect + answer-buffer retry loop
    // (lib/answer-buffer.ts, 10s default interval) picking it back up.
    await expect(freeTextCard.locator("svg.text-green-600")).toBeVisible({
      timeout: 20000,
    })

    // Confirm the edit is genuinely server-side, not just optimistic client
    // state or a localStorage buffer that never actually synced: reload and
    // check the value comes back from the session load (server + localStorage
    // buffer replay — see ExamRunner's load effect).
    await page.reload()
    await page.waitForURL(`**/exam/${exam.id}/take`)
    await expect(
      page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible({ timeout: 10000 })
    await expect(freeTextCard.getByRole("textbox")).toHaveValue(offlineAnswer)

    const afterTimer = page
      .locator("header")
      .getByText(/\d{1,2}:\d{2}(:\d{2})?/)
    const postText = await afterTimer.textContent()
    expect(postText).toMatch(/\d/)

    const preSeconds = parseTimerSeconds(preText)
    const postSeconds = parseTimerSeconds(postText)
    expect(postSeconds).toBeLessThanOrEqual(preSeconds!)
  })
})

function parseTimerSeconds(text: string | null): number | null {
  if (!text) return null
  const parts = text.split(":").map(Number)
  // Accepts MM:SS and H:MM:SS (see the TimerBadge comment above).
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1]
}
