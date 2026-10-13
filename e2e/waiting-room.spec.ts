import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"
import {
  ORIGIN_HEADER,
  createPublishedExam,
  promoteToTeacher,
  signUp,
  uniqueEmail,
} from "./helpers"

// Shares the file-wide auth rate-limit budget with the other spec files
// (see toctou-fixes.spec.ts) — keep this serial.
test.describe.configure({ mode: "serial" })

const QUESTION = "Was ist die Hauptstadt der Schweiz?"

type SessionInfo = {
  id: string
  status: string
  startedAt: string | null
  effectiveEndTime: string | null
  exam: { id: string }
}

async function newStudent(browser: Browser, name: string) {
  const context = await browser.newContext()
  await signUp(context.request, { name, email: uniqueEmail("wr-student") })
  return context
}

async function joinViaForm(page: Page, accessCode: string) {
  await page.goto("/dashboard/student")
  await page.getByRole("textbox", { name: "Zugangscode" }).fill(accessCode)
  await page.getByRole("button", { name: /Teilnehmen/ }).click()
}

async function sessionFor(
  context: BrowserContext,
  examId: string
): Promise<SessionInfo> {
  const res = await context.request.get("/api/sessions")
  expect(res.ok(), await res.text()).toBe(true)
  const { sessions } = (await res.json()) as { sessions: SessionInfo[] }
  const found = sessions.find((s) => s.exam.id === examId)
  expect(found, "student has a session for the exam").toBeTruthy()
  return found!
}

/**
 * Shared start: students wait in the waiting room until the teacher presses
 * Start in the live monitor, then everyone's clock starts at the same moment
 * with the full time limit; a late joiner still gets the full time limit
 * from their own join.
 */
test.describe.serial("waiting room — shared start", () => {
  let teacher: BrowserContext

  test.beforeAll(async ({ browser }) => {
    teacher = await browser.newContext()
    const email = uniqueEmail("wr-teacher")
    await signUp(teacher.request, { name: "Warteraum Lehrer", email })
    await promoteToTeacher(teacher.request, { email })
  })

  test.afterAll(async () => {
    await teacher.close()
  })

  test("refuses entry before the waiting room opens", async ({ browser }) => {
    const exam = await createPublishedExam(
      teacher.request,
      `Warteraum später ${Date.now()}`,
      {
        waitingRoom: true,
        scheduledStart: new Date(Date.now() + 60 * 60_000).toISOString(),
      }
    )
    const student = await newStudent(browser, "Zu Früh")
    const res = await student.request.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(res.status(), await res.text()).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe("NOT_STARTED")
    expect(body.error.message).toContain("Der Warteraum öffnet am")
    await student.close()
  })

  test("everyone waits, starts together on Start, and late joiners get the full time", async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const exam = await createPublishedExam(
      teacher.request,
      `Warteraum ${Date.now()}`,
      {
        waitingRoom: true,
        scheduledStart: new Date(Date.now() - 60_000).toISOString(),
      }
    )

    // Three students enter the waiting room through the normal join form.
    const students = await Promise.all(
      ["Anna", "Ben", "Chiara"].map((name) => newStudent(browser, name))
    )
    const pages = await Promise.all(students.map((s) => s.newPage()))
    for (const page of pages) {
      await joinViaForm(page, exam.accessCode)
      await expect(page).toHaveURL(new RegExp(`/exam/${exam.id}/wait$`))
      await expect(page.getByText(/Du bist im Warteraum/)).toBeVisible()
    }

    // No clock yet, and no questions to be had before Start.
    const waiting = await sessionFor(students[0], exam.id)
    expect(waiting).toMatchObject({
      status: "WAITING",
      startedAt: null,
      effectiveEndTime: null,
    })
    const early = await students[0].request.get(`/api/sessions/${waiting.id}`)
    expect(early.status()).toBe(409)
    expect(await early.text()).not.toContain(QUESTION)
    // /take sends a waiting student back to the room.
    await pages[0].goto(`/exam/${exam.id}/take`)
    await expect(pages[0]).toHaveURL(new RegExp(`/exam/${exam.id}/wait$`))

    // While people wait, the room and the SEB requirement are frozen.
    for (const data of [{ waitingRoom: false }, { sebRequired: true }]) {
      const res = await teacher.request.patch(`/api/exams/${exam.id}`, {
        headers: ORIGIN_HEADER,
        data,
      })
      expect(res.status(), JSON.stringify(data)).toBe(409)
    }

    // The teacher sees the room and starts the exam from the monitor.
    const monitor = await teacher.newPage()
    await monitor.goto(`/dashboard/teacher/monitor/${exam.id}`)
    await expect(monitor.getByText("3 im Warteraum")).toBeVisible()
    await monitor.getByRole("button", { name: "Prüfung starten" }).click()
    await expect(
      monitor.getByText(/3 Personen im Warteraum beginnen/)
    ).toBeVisible()
    await monitor.getByRole("button", { name: "Jetzt starten" }).click()
    await expect(monitor.getByText(/aus dem Warteraum beginnen/)).toBeVisible()

    // Each room counts down, then opens the exam.
    for (const page of pages) {
      await expect(page.getByText(/Die Prüfung beginnt in \d+ s/)).toBeVisible({
        timeout: 10_000,
      })
    }
    for (const page of pages) {
      await expect(page).toHaveURL(new RegExp(`/exam/${exam.id}/take$`), {
        timeout: 30_000,
      })
      await expect(page.getByText(QUESTION)).toBeVisible({ timeout: 15_000 })
    }

    // One shared start and one shared deadline, the full 30 minutes.
    const started = await Promise.all(
      students.map((s) => sessionFor(s, exam.id))
    )
    const sharedStart = started[0].startedAt!
    for (const s of started) {
      expect(s.status).toBe("IN_PROGRESS")
      expect(s.startedAt).toBe(sharedStart)
      expect(s.effectiveEndTime).toBe(started[0].effectiveEndTime)
      expect(
        new Date(s.effectiveEndTime!).getTime() -
          new Date(s.startedAt!).getTime()
      ).toBe(30 * 60_000)
    }

    // A late joiner goes straight to the exam with their own full time.
    const late = await newStudent(browser, "Dario")
    const latePage = await late.newPage()
    await joinViaForm(latePage, exam.accessCode)
    await expect(latePage).toHaveURL(new RegExp(`/exam/${exam.id}/take$`))
    await expect(latePage.getByText(QUESTION)).toBeVisible()
    const lateSession = await sessionFor(late, exam.id)
    expect(new Date(lateSession.startedAt!).getTime()).toBeGreaterThan(
      new Date(sharedStart).getTime()
    )
    expect(
      new Date(lateSession.effectiveEndTime!).getTime() -
        new Date(lateSession.startedAt!).getTime()
    ).toBe(30 * 60_000)

    await monitor.close()
    await Promise.all([...students, late].map((s) => s.close()))
  })

  test("the editor switch hides the scheduled end and is saved", async () => {
    const res = await teacher.request.post("/api/exams", {
      data: { title: `Warteraum Editor ${Date.now()}`, timeLimitMin: 45 },
    })
    const { exam } = await res.json()
    // A stored end: switching the shared start on must clear it.
    await teacher.request.patch(`/api/exams/${exam.id}`, {
      headers: ORIGIN_HEADER,
      data: { scheduledEnd: new Date(Date.now() + 60 * 60_000).toISOString() },
    })
    const page = await teacher.newPage()
    await page.goto(`/dashboard/teacher/exams/${exam.id}/edit`)
    await expect(page.getByText("Geplantes Ende")).toBeVisible()

    // A click that lands before hydration is lost.
    await page.waitForLoadState("networkidle")
    const toggle = page.getByRole("switch", { name: /Gemeinsamer Start/ })
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(page.getByText("Warteraum öffnet ab")).toBeVisible()
    await expect(page.getByText("Geplantes Ende")).toHaveCount(0)

    const saved = async () => {
      const r = await teacher.request.get(`/api/exams/${exam.id}`)
      const { waitingRoom, scheduledEnd } = (await r.json()).exam
      return { waitingRoom, scheduledEnd }
    }
    await expect.poll(saved).toEqual({ waitingRoom: true, scheduledEnd: null })
    // Past the autosave debounce: nothing queued may turn it back off.
    await page.waitForTimeout(1_500)
    expect(await saved()).toEqual({ waitingRoom: true, scheduledEnd: null })
  })
})
