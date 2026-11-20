import { expect, test } from "@playwright/test"
import { prisma } from "../lib/prisma"
import { configKeyTokenForUrl } from "../lib/seb-key"
import { takeUrl } from "../lib/seb-urls"
import {
  createPublishedExam,
  promoteToTeacher,
  signUp,
  uniqueEmail,
} from "./helpers"

test.afterAll(async () => {
  await prisma.$disconnect()
})

for (const sebRequired of [true, false]) {
  test(`exam timer starts ${sebRequired ? "after verified SEB entry" : "on join without SEB"}`, async ({
    page,
    playwright,
  }) => {
    test.setTimeout(120_000)
    const email = uniqueEmail("timer-teacher")
    await signUp(page.request, { name: "Timer Teacher", email })
    await promoteToTeacher(page.request, { email })
    const exam = await createPublishedExam(page.request, "Timer start", {
      sebRequired,
    })
    const activated = await page.request.post(`/api/exams/${exam.id}/activate`)
    expect(activated.ok(), await activated.text()).toBe(true)
    const student = await playwright.request.newContext()
    try {
      await signUp(student, {
        name: "Timer Student",
        email: uniqueEmail("timer-student"),
      })
      const joined = await student.post("/api/sessions", {
        data: { accessCode: exam.accessCode },
      })
      expect(joined.ok(), await joined.text()).toBe(true)
      const { sessionId } = await joined.json()
      const row = () =>
        prisma.examSession.findUniqueOrThrow({
          where: { id: sessionId },
        })
      const initial = await row()
      if (!sebRequired) {
        expect(initial.startedAt).not.toBeNull()
        expect(
          initial.effectiveEndTime!.getTime() - initial.startedAt!.getTime()
        ).toBe(30 * 60_000)
        return
      }
      expect(initial.startedAt).toBeNull()
      expect(initial.effectiveEndTime).toBeNull()
      expect((await student.get(`/api/sessions/${sessionId}`)).status()).toBe(
        403
      )
      const rejoined = await student.post("/api/sessions", {
        data: { accessCode: exam.accessCode },
      })
      expect(rejoined.ok(), await rejoined.text()).toBe(true)
      expect((await row()).startedAt).toBeNull()

      // Exercise the same Config Key proof used by SEB on Windows and macOS.
      // The native application itself is outside Playwright's browser support.
      const configured = await prisma.exam.findUniqueOrThrow({
        where: { id: exam.id },
      })
      const headers = {
        "x-safeexambrowser-configkeyhash": configKeyTokenForUrl(
          takeUrl(exam.id),
          configured.sebConfigKey!
        ),
        "user-agent": "SEB/3.10.2",
      }
      // A teacher grant made before entry must be included in the new clock.
      await prisma.examSession.update({
        where: { id: sessionId },
        data: { timeExtensionMin: 5 },
      })
      const beforeEntry = Date.now()
      const entered = await student.get(`/api/sessions/${sessionId}`, {
        headers,
      })
      expect(entered.ok(), await entered.text()).toBe(true)
      const started = await row()
      expect(started.startedAt!.getTime()).toBeGreaterThanOrEqual(beforeEntry)
      expect(
        started.effectiveEndTime!.getTime() - started.startedAt!.getTime()
      ).toBe(35 * 60_000)
      const reload = await student.get(`/api/sessions/${sessionId}`, {
        headers,
      })
      expect(reload.ok(), await reload.text()).toBe(true)
      expect((await row()).effectiveEndTime).toEqual(started.effectiveEndTime)
    } finally {
      await student.dispose()
    }
  })
}
