import { test, expect } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "./helpers"

/**
 * T12 — REST fallback when WebSocket is unavailable.
 *
 * The exam client's answer-save path attempts WebSocket first and falls
 * back to REST (PUT /api/sessions/{id}/answers). This test blocks the
 * WebSocket upgrade and verifies that answers are still persisted via
 * the REST path with no data loss.
 */
test.describe("WS outage REST fallback", () => {
  let exam: SeededExam

  test.beforeAll(async ({ playwright, baseURL }) => {
    const teacher = await playwright.request.newContext({ baseURL })
    const email = uniqueEmail("stress-t12-teacher")
    await signUp(teacher, { name: "Stress T12 Teacher", email })
    await promoteToTeacher(teacher, { email })
    exam = await createActiveExam(
      teacher,
      `Stress T12 — REST Fallback ${Date.now()}`
    )
    await teacher.dispose()
  })

  test("answers saved via REST when WS is blocked", async ({ page }) => {
    // Block all WebSocket connections so the client is forced onto the
    // REST fallback path for every answer save.
    //
    // route.send("") (the old approach) does NOT simulate a failed
    // connection: page.routeWebSocket still completes the handshake as far
    // as the page is concerned, so the client's `ws.onopen` fires and
    // `connected` flips true (see hooks/use-exam-socket.ts) exactly as it
    // would for a healthy socket — an empty string is just parsed as a
    // no-op message (JSON.parse("") throws, caught and ignored). The
    // client would then only fall back to REST after burning the full 5s
    // answer:ack timeout per save, which is really "ack timeout falls back
    // to REST", not "WS connection failure falls back to REST".
    //
    // route.close() instead rejects the handshake outright: the client
    // never sees `onopen`, only `onclose`, exactly like a real refused/
    // dropped connection. Because useExamSocket's reconnect loop retries
    // indefinitely (with backoff) and this handler runs again on every
    // retry, the socket is kept genuinely down for the whole test, so
    // `sendAnswer`'s `ws.readyState !== WebSocket.OPEN` fast path is what
    // actually triggers REST — the real fallback branch — for every save.
    await page.routeWebSocket(/\/ws\//, (route) => {
      route.close({ code: 1006, reason: "mocked WS outage" })
    })

    await signUp(page.request, {
      name: "Stress T12 Student",
      email: uniqueEmail("stress-t12-student"),
    })

    await page.goto("/dashboard/student")
    await page.locator("input").fill(exam.accessCode)
    await page.getByRole("button", { name: "Teilnehmen" }).click()
    await page.waitForURL(`**/exam/${exam.id}/take`)

    await expect(
      page.getByText("Was ist die Hauptstadt der Schweiz?")
    ).toBeVisible()

    await page.getByText("Bern", { exact: true }).click()
    await page.getByRole("textbox").fill("REST fallback answer text")

    // Autosave debounce is 800ms, plus network — 5s is generous.
    await expect(
      page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible({ timeout: 10000 })

    // Verify answers persisted by reloading the page and checking for
    // restored answers (the client replays localStorage buffers on load
    // and refetches from the server).
    await page.reload()
    await page.waitForURL(`**/exam/${exam.id}/take`)

    await expect(
      page.getByRole("banner").getByText("2 von 2 Fragen beantwortet")
    ).toBeVisible({ timeout: 10000 })

    await expect(page.getByRole("textbox")).toHaveValue(
      "REST fallback answer text"
    )
  })
})
