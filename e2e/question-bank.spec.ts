import { test, expect, type APIRequestContext } from "@playwright/test"
import { uniqueEmail, signUp, promoteToTeacher, ORIGIN_HEADER } from "./helpers"

// Shares the file-wide auth rate-limit budget with the other spec files —
// serial keeps the few sign-ups/sign-ins from racing other describe blocks.
test.describe.configure({ mode: "serial" })

/**
 * Fragenbank round-trip: a teacher shares a bank item by link, another
 * teacher copies it into their own bank through the shared-item UI, and a
 * question created in an exam can be pushed back into the bank from the exam
 * editor.
 */
test.describe.serial("question bank — share, copy, and save-to-bank", () => {
  let teacherA: APIRequestContext
  let shareToken: string
  const sharedTitle = `Geteilte Frage ${Date.now()}`

  test.beforeAll(async ({ playwright, baseURL }) => {
    teacherA = await playwright.request.newContext({ baseURL })
    const teacherAEmail = uniqueEmail("bank-shareA")
    await signUp(teacherA, { name: "E2E Bank Teacher A", email: teacherAEmail })
    await promoteToTeacher(teacherA, { email: teacherAEmail })

    const createRes = await teacherA.post("/api/question-bank", {
      headers: ORIGIN_HEADER,
      data: {
        type: "SHORT_ANSWER",
        title: sharedTitle,
        points: 2,
        required: true,
        config: {
          acceptedAnswers: ["Bern"],
          caseSensitive: false,
          maxLength: 100,
        },
      },
    })
    expect(createRes.ok(), await createRes.text()).toBe(true)
    const { item } = await createRes.json()

    // Routes guarded by verifyOrigin reject origin-less POSTs; the helpers
    // send ORIGIN_HEADER explicitly, these direct calls must too.
    const shareRes = await teacherA.post(`/api/question-bank/${item.id}/share`, {
      headers: ORIGIN_HEADER,
    })
    expect(shareRes.ok(), await shareRes.text()).toBe(true)
    const body = await shareRes.json()
    shareToken = body.shareToken
    expect(shareToken).toMatch(/^[0-9a-f]{32}$/)
  })

  test.afterAll(async () => {
    await teacherA.dispose()
  })

  test("another teacher copies a shared item into their own bank via the link", async ({
    page,
  }) => {
    const teacherBEmail = uniqueEmail("bank-shareB")
    await signUp(page.request, {
      name: "E2E Bank Teacher B",
      email: teacherBEmail,
    })
    await promoteToTeacher(page.request, { email: teacherBEmail })

    await page.goto(`/dashboard/teacher/question-bank/shared/${shareToken}`)
    await expect(page.getByText(sharedTitle)).toBeVisible()
    await expect(
      page.getByText(`Geteilte Frage von E2E Bank Teacher A`)
    ).toBeVisible()

    await page
      .getByRole("button", { name: "In meine Fragenbank übernehmen" })
      .click()
    await page.waitForURL("**/dashboard/teacher/question-bank")

    // The copied item is now listed in teacher B's bank.
    await expect(page.getByRole("table")).toContainText(sharedTitle)
  })

  test("an exam question can be saved into the bank from the exam editor", async ({
    page,
  }) => {
    const email = uniqueEmail("bank-ui-teacher")
    await signUp(page.request, { name: "E2E Bank UI Teacher", email })
    await promoteToTeacher(page.request, { email })

    const examRes = await page.request.post("/api/exams", {
      data: {
        title: `Bank UI Prüfung ${Date.now()}`,
        timeLimitMin: 30,
      },
    })
    expect(examRes.ok(), await examRes.text()).toBe(true)
    const { exam } = await examRes.json()

    const qRes = await page.request.post(`/api/exams/${exam.id}/questions`, {
      data: {
        type: "TRUE_FALSE",
        title: "Zürich liegt an der Limmat",
        points: 1,
        required: true,
        config: { isCorrect: true },
      },
    })
    expect(qRes.ok(), await qRes.text()).toBe(true)

    await page.goto(`/dashboard/teacher/exams/${exam.id}/edit`)
    await expect(page.getByText("Zürich liegt an der Limmat")).toBeVisible()

    await page
      .getByRole("button", { name: "Frage in Fragenbank speichern" })
      .click()
    await expect(
      page.getByText("Frage in Fragenbank gespeichert")
    ).toBeVisible()

    const bankRes = await page.request.get("/api/question-bank?q=Zürich")
    expect(bankRes.ok()).toBe(true)
    const bankData = await bankRes.json()
    expect(bankData.total).toBe(1)
    expect(bankData.items[0].title).toBe("Zürich liegt an der Limmat")
  })
})
