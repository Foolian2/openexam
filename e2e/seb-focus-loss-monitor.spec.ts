import { expect, test } from "@playwright/test"
import { prisma } from "../lib/prisma"
import {
  createActiveExam,
  promoteToTeacher,
  signUp,
  uniqueEmail,
} from "./helpers"

test.afterAll(async () => {
  await prisma.$disconnect()
})

test("informational SEB focus loss stays out of the attention queue", async ({
  page,
  playwright,
}, testInfo) => {
  test.setTimeout(120_000)
  const teacherEmail = uniqueEmail("focus-teacher")
  await signUp(page.request, { name: "Focus Teacher", email: teacherEmail })
  await promoteToTeacher(page.request, { email: teacherEmail })
  const exam = await createActiveExam(page.request, "SEB Fokusverlust")
  const student = await playwright.request.newContext()
  try {
    await signUp(student, {
      name: "SEB Testperson",
      email: uniqueEmail("focus-student"),
    })
    const joined = await student.post("/api/sessions", {
      data: { accessCode: exam.accessCode },
    })
    expect(joined.ok(), await joined.text()).toBe(true)
    const { sessionId } = await joined.json()
    // Seed the persisted signals: native focus behavior is covered separately
    // on macOS, and the WS acceptance/counting path has Go integration tests.
    await prisma.integrityEvent.createMany({
      data: [0, 1].map(() => ({
        sessionId,
        kind: "PAGE_FOCUS_LOST" as const,
        clientTime: new Date(),
      })),
    })

    await page.goto(`/dashboard/teacher/monitor/${exam.id}`)
    const info = page.getByRole("button", { name: "2 Hinweise" })
    await expect(info).toBeVisible()
    await expect(info).not.toHaveClass(/text-destructive/)
    await expect(page.getByText("Benötigt Aufmerksamkeit")).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath("focus-loss-info-monitor.png"),
      fullPage: true,
    })
    await info.click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toContainText(
      "Prüfungsseite hat Fokus verloren (Hinweis)"
    )
    await expect(
      dialog.getByText("Fenster verlassen", { exact: true })
    ).toHaveCount(0)
    await dialog.screenshot({
      path: testInfo.outputPath("focus-loss-history.png"),
    })
    await page.keyboard.press("Escape")

    await prisma.integrityEvent.create({
      data: { sessionId, kind: "TAB_HIDDEN", clientTime: new Date() },
    })
    await page.reload()
    await expect(
      page.getByText("Benötigt Aufmerksamkeit").first()
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "1 Auffälligkeit · 2 Hinweise" })
    ).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath("focus-loss-monitor.png"),
      fullPage: true,
    })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      page.getByRole("button", { name: "1 Auffälligkeit · 2 Hinweise" })
    ).toBeVisible()
  } finally {
    await student.dispose()
  }
})
