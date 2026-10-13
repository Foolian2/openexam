// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const push = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

import { JoinExamForm } from "@/components/exam-taking/join-exam-form"

const fetchMock = vi.fn()

beforeEach(() => {
  push.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  // input-otp measures layout and schedules focus work through these.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

async function typeCode(code: string) {
  const user = userEvent.setup()
  render(<JoinExamForm />)
  await user.type(screen.getByRole("textbox", { name: "Zugangscode" }), code)
  return user
}

const submit = () => screen.getByRole("button", { name: /Teilnehmen/ })

it("keeps submit disabled until all six characters are entered", async () => {
  await typeCode("abc23")
  expect(submit()).toBeDisabled()
  await userEvent.type(
    screen.getByRole("textbox", { name: "Zugangscode" }),
    "4"
  )
  expect(submit()).toBeEnabled()
})

it("rejects characters the server's code alphabet never uses", async () => {
  await typeCode("a0b1c")
  // 0 and 1 are filtered by the pattern, so only three characters land.
  expect(screen.getByRole("textbox", { name: "Zugangscode" })).toHaveValue(
    "ABC"
  )
})

it("posts the upper-cased code and opens the exam", async () => {
  fetchMock.mockResolvedValue(jsonResponse(200, { examId: "exam-9" }))
  const user = await typeCode("abc234")
  await user.click(submit())

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sessions",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ accessCode: "ABC234" }),
    })
  )
  expect(push).toHaveBeenCalledWith("/exam/exam-9/take")
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it("shows the server's error message and stays on the page", async () => {
  fetchMock.mockResolvedValue(
    jsonResponse(404, { error: { message: "Prüfung nicht gefunden" } })
  )
  const user = await typeCode("abc234")
  await user.click(submit())
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Prüfung nicht gefunden"
  )
  expect(push).not.toHaveBeenCalled()
  expect(submit()).toBeEnabled()
})

it("falls back to a generic message when the error has none", async () => {
  fetchMock.mockResolvedValue(jsonResponse(500, {}))
  const user = await typeCode("abc234")
  await user.click(submit())
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Beitritt fehlgeschlagen"
  )
})

it("reports a network failure and clears the error once the code is edited", async () => {
  fetchMock.mockRejectedValue(new TypeError("offline"))
  const user = await typeCode("abc234")
  await user.click(submit())
  expect(await screen.findByRole("alert")).toHaveTextContent("Netzwerkfehler")

  await user.type(
    screen.getByRole("textbox", { name: "Zugangscode" }),
    "{Backspace}"
  )
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

it("stays busy from submit through the navigation", async () => {
  let resolve!: (r: Response) => void
  fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)))
  const user = await typeCode("abc234")
  await user.click(submit())
  expect(screen.getByRole("button", { name: /Wird geprüft/ })).toBeDisabled()
  resolve(jsonResponse(200, { examId: "e" }))
  await waitFor(() => expect(push).toHaveBeenCalledWith("/exam/e/take"))
  // Re-enabling before the route changes would invite a second join.
  expect(screen.getByRole("button", { name: /Wird geprüft/ })).toBeDisabled()
})
