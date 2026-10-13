import { expect, test } from "@playwright/test"
import { promoteToTeacher, signUp, uniqueEmail } from "./helpers"
import { SEB_FILE_UPLOAD_MESSAGE } from "../lib/seb-question-policy"

test("SEB exams disable upload creation, quick add, and bank import", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const email = uniqueEmail("seb-upload-policy")
  await signUp(page.request, { name: "SEB Upload Teacher", email })
  await promoteToTeacher(page.request, { email })
  const created = await page.request.post("/api/exams", {
    data: {
      title: "SEB upload restriction",
      timeLimitMin: 60,
      sebRequired: true,
    },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { exam } = await created.json()
  const upload = {
    type: "FILE_UPLOAD",
    title: "Upload PDF",
    points: 1,
    required: true,
    config: {
      allowedExtensions: [".pdf"],
      maxFileSizeMB: 10,
      instructions: "",
    },
  }
  const bank = await page.request.post("/api/question-bank", { data: upload })
  expect(bank.ok(), await bank.text()).toBe(true)
  const { item } = await bank.json()
  const questionURL = `/api/exams/${exam.id}/questions`
  const blocked = await page.request.post(questionURL, { data: upload })
  expect(blocked.status()).toBe(422)
  const importBlocked = await page.request.post(`${questionURL}/from-bank`, {
    data: { bankItemId: item.id },
  })
  expect(importBlocked.status()).toBe(422)

  await page.addInitScript(() => {
    window.localStorage.setItem("nextopen.last-question-type", "FILE_UPLOAD")
  })
  await page.goto(`/dashboard/teacher/exams/${exam.id}/edit`)
  await page
    .getByRole("button", { name: "Frage hinzufügen", exact: true })
    .click()
  const picker = page.getByRole("dialog")
  await expect(
    picker.getByRole("button", { name: /Datei-Upload/ })
  ).toBeDisabled()
  await expect(picker.getByRole("button", { name: /Freitext/ })).toBeEnabled()
  await page.screenshot({
    path: testInfo.outputPath("seb-upload-disabled.png"),
  })
  await page.keyboard.press("Escape")

  await page.getByRole("button", { name: "Fragetyp direkt wählen" }).click()
  await expect(
    page.getByRole("menuitem", { name: "Datei-Upload", exact: true })
  ).toHaveAttribute("aria-disabled", "true")
  await expect(
    page.getByText("Zuletzt verwendet", { exact: true })
  ).toHaveCount(0)
  await page.keyboard.press("Escape")

  await page
    .getByRole("button", { name: "Aus Fragenbank", exact: true })
    .click()
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /Upload PDF/ })
  ).toBeDisabled()
  await page.keyboard.press("Escape")

  const disabled = await page.request.patch(`/api/exams/${exam.id}`, {
    data: { sebRequired: false },
  })
  expect(disabled.ok(), await disabled.text()).toBe(true)
  const added = await page.request.post(questionURL, { data: upload })
  expect(added.status()).toBe(201)
  const enabling = await page.request.patch(`/api/exams/${exam.id}`, {
    data: { sebRequired: true },
  })
  expect(enabling.status()).toBe(422)
  expect((await enabling.json()).error.message).toBe(SEB_FILE_UPLOAD_MESSAGE)
  await page.reload()
  await expect(
    page.getByRole("switch", { name: "Safe Exam Browser erforderlich" })
  ).toBeDisabled()
})
