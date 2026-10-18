import { test, expect } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  extendSession,
} from "./helpers"

/**
 * T5 — Live time extension via WebSocket (timer:sync).
 *
 * A teacher extends a student's remaining time during an active exam.
 * The student, already connected to the WebSocket, must see the timer
 * update in real time without a page reload.
 *
 * Note: requires ws-backend and Better Auth session persistence
 * (storeSessionInDatabase: true) to be configured — see #46.
 */
test.describe("live time extension", () => {
  test("teacher extends time, student sees updated timer via WS", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const teacherCtx = await playwright.request.newContext({ baseURL })
    const teacherEmail = uniqueEmail("stress-t5-teacher")
    await signUp(teacherCtx, {
      name: "Stress T5 Teacher",
      email: teacherEmail,
    })
    await promoteToTeacher(teacherCtx, { email: teacherEmail })
    const exam = await createActiveExam(
      teacherCtx,
      `Stress T5 — Extend ${Date.now()}`
    )

    // Student joins via browser.
    await signUp(page.request, {
      name: "Stress T5 Student",
      email: uniqueEmail("stress-t5-student"),
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
    const initialText = await timerLocator.textContent()

    // Get the session id for this student from the teacher export.
    const sessionsRes = await teacherCtx.get(
      `/api/exams/${exam.id}/sessions`
    )
    const { sessions } = await sessionsRes.json()
    expect(sessions.length).toBeGreaterThanOrEqual(1)
    const sessionId: string = sessions[0].id

    // Extend time — this publishes SESSION_EXTENDED over Redis, which
    // ws-backend relays to the client as timer:sync.
    await extendSession(teacherCtx, sessionId, 5)

    // Wait for the WS timer:sync round-trip. The clock updates every 1s
    // in the UI, so the new value should reflect the extra 5 minutes.
    await page.waitForTimeout(3000)

    const updatedText = await timerLocator.textContent()

    const initSec = parseTimer(initialText)
    const updSec = parseTimer(updatedText)
    expect(initSec, "initial timer text should be parseable").not.toBeNull()
    expect(updSec, "updated timer text should be parseable").not.toBeNull()

    // A real 5-minute (300s) extension must land, not just ordinary
    // per-second countdown ticking (which only ever *decreases* the
    // remaining time by a couple of seconds). Allow generous slack on both
    // sides for the few seconds of natural countdown that elapsed between
    // reading initialText and the extend call landing, plus WS round-trip
    // latency — but the window is centered on +300s, so a test that merely
    // ticked down (delta ~ -3) or stayed flat (delta ~ 0) cannot pass this.
    const deltaSec = updSec! - initSec!
    expect(
      deltaSec,
      `expected timer to jump by ~300s after a 5-minute extension, got delta=${deltaSec}s (init=${initSec}s, updated=${updSec}s)`
    ).toBeGreaterThan(280)
    expect(deltaSec).toBeLessThan(320)

    await teacherCtx.dispose()
  })
})

function parseTimer(text: string | null): number | null {
  if (!text) return null
  const parts = text.split(":").map(Number)
  // Accepts MM:SS and H:MM:SS (see the TimerBadge comment above).
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1]
}
