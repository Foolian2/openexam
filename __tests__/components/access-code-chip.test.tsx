// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast: toastMock }))

import { AccessCodeChip } from "@/components/exams/access-code-chip"

const writeText = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  writeText.mockReset().mockResolvedValue(undefined)
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue({
    writeText,
  } as unknown as Clipboard)
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function click() {
  await act(async () => {
    screen.getByRole("button", { name: "Zugangscode ABC234 kopieren" }).click()
  })
}

it("copies the code, confirms, and reverts the icon after 2s", async () => {
  const { container } = render(<AccessCodeChip code="ABC234" />)
  const icon = () => container.querySelector("svg")!.getAttribute("class")
  expect(icon()).toContain("lucide-copy")

  await click()
  expect(writeText).toHaveBeenCalledWith("ABC234")
  expect(toastMock.success).toHaveBeenCalledWith("Zugangscode kopiert")
  expect(icon()).toContain("lucide-check")

  act(() => vi.advanceTimersByTime(2_000))
  expect(icon()).toContain("lucide-copy")
})

it("reports a failed copy instead of claiming success", async () => {
  writeText.mockRejectedValue(new Error("denied"))
  render(<AccessCodeChip code="ABC234" />)
  await click()
  expect(toastMock.error).toHaveBeenCalledWith("Kopieren fehlgeschlagen")
  expect(toastMock.success).not.toHaveBeenCalled()
})
