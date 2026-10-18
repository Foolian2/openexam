// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import {
  ExamMetadataForm,
  type SaveStatus,
} from "@/components/exams/exam-metadata-form"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { CreateExamInput } from "@/lib/validators/exam"

function renderForm(props: {
  onSubmit: (data: CreateExamInput) => Promise<void>
  onStatusChange?: (status: SaveStatus) => void
}) {
  return render(
    <TooltipProvider>
      <ExamMetadataForm
        autosave
        onSubmit={props.onSubmit}
        onStatusChange={props.onStatusChange}
        defaultValues={{
          title: "Before",
          timeLimitMin: 60,
          sebRequired: false,
        }}
      />
    </TooltipProvider>
  )
}

afterEach(() => {
  vi.useRealTimers()
})

it("cancels an old text snapshot when enabling SEB", async () => {
  const submit = vi.fn().mockResolvedValue(undefined)
  renderForm({ onSubmit: submit })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await new Promise((r) => setTimeout(r, 30))
  fireEvent.click(screen.getByRole("switch", { name: /Safe Exam Browser/ }))
  await waitFor(() => expect(submit).toHaveBeenCalled())
  await new Promise((r) => setTimeout(r, 750))
  const flags = submit.mock.calls.map(([data]) => data.sebRequired)
  expect(flags).toEqual([true])
  expect(
    screen.getByRole("switch", { name: /Safe Exam Browser/ })
  ).toHaveAttribute("aria-checked", "true")
})

it("serializes slow requests and coalesces rapid switches to the newest state", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let active = 0
  let peak = 0
  const submit = vi.fn<(data: CreateExamInput) => Promise<void>>(async () => {
    active++
    peak = Math.max(peak, active)
    if (submit.mock.calls.length === 1) await held
    active--
  })
  renderForm({ onSubmit: submit })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  const seb = screen.getByRole("switch", { name: /Safe Exam Browser/ })
  fireEvent.click(seb)
  await new Promise((r) => setTimeout(r, 20))
  fireEvent.click(seb)
  fireEvent.click(seb)
  await new Promise((r) => setTimeout(r, 20))
  expect(submit).toHaveBeenCalledTimes(1)
  release()
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
  expect(peak).toBe(1)
  expect(submit.mock.calls.at(-1)?.[0]).toMatchObject({
    title: "After",
    sebRequired: true,
  })
})

it("still sends a switch save queued behind an in-flight request after unmount", async () => {
  vi.useFakeTimers()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const submit = vi.fn<(data: CreateExamInput) => Promise<void>>(async () => {
    if (submit.mock.calls.length === 1) await held
  })
  const { unmount } = renderForm({ onSubmit: submit })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  // The title PATCH is still in flight, so the switch save sits in the queue.
  fireEvent.click(screen.getByRole("switch", { name: /Safe Exam Browser/ }))
  await act(async () => {})
  unmount()
  release()
  await act(async () => {})
  // Navigating away must not drop a queued save: the server never learns
  // about the switch otherwise, while the editor showed it as toggled.
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[1]?.[0]).toMatchObject({
    title: "After",
    sebRequired: true,
  })
})

it("still saves a debounced text edit when unmounting inside the debounce window", async () => {
  vi.useFakeTimers()
  const submit = vi.fn().mockResolvedValue(undefined)
  const onStatusChange = vi.fn()
  const { unmount } = renderForm({ onSubmit: submit, onStatusChange })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
  // Still inside the 600 ms debounce: the edit is only scheduled, but the
  // status line has already claimed it is being saved.
  expect(submit).not.toHaveBeenCalled()
  expect(onStatusChange).toHaveBeenLastCalledWith("saving")
  unmount()
  await act(async () => {})
  // Navigating away must still write the snapshot the "saving" status
  // promised. The status line is gone with the component, so nothing may be
  // reported after teardown either — but the data must not be lost.
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ title: "After" })
  expect(onStatusChange).toHaveBeenLastCalledWith("saving")
})

it("an invalid newer edit does not cancel a queued switch save", async () => {
  vi.useFakeTimers()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const submit = vi.fn<(data: CreateExamInput) => Promise<void>>(async () => {
    if (submit.mock.calls.length === 1) await held
  })
  renderForm({ onSubmit: submit })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("switch", { name: /Safe Exam Browser/ }))
  await act(async () => {})
  // Clearing the required title is invalid. The queued switch save was
  // already accepted and must survive the invalid snapshot.
  fireEvent.change(screen.getByLabelText(/Titel/), { target: { value: "" } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  release()
  await act(async () => {})
  expect(submit).toHaveBeenCalledTimes(2)
  expect(submit.mock.calls[1]?.[0]).toMatchObject({
    title: "After",
    sebRequired: true,
  })
})

it("does not report a save error for a validation-only failure", async () => {
  vi.useFakeTimers()
  const submit = vi.fn().mockResolvedValue(undefined)
  const onStatusChange = vi.fn()
  renderForm({ onSubmit: submit, onStatusChange })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(onStatusChange).toHaveBeenLastCalledWith("saved")
  onStatusChange.mockClear()
  fireEvent.change(screen.getByLabelText(/Titel/), { target: { value: "" } })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  // No request was made, so "Fehler beim Speichern" would be a lie; the
  // inline field error carries the explanation instead.
  expect(onStatusChange).not.toHaveBeenCalled()
  expect(screen.getByText("Titel ist erforderlich")).toBeTruthy()
})

it("does not report saved for a superseded save while a newer edit is pending", async () => {
  vi.useFakeTimers()
  const resolvers: Array<() => void> = []
  const submit = vi.fn<(data: CreateExamInput) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve)
      })
  )
  const onStatusChange = vi.fn()
  renderForm({ onSubmit: submit, onStatusChange })
  fireEvent.change(screen.getByLabelText(/Titel/), {
    target: { value: "After" },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("switch", { name: /Safe Exam Browser/ }))
  await act(async () => {})
  // The first save finishes while the switch save is newer and pending.
  resolvers[0]?.()
  await act(async () => {})
  expect(submit).toHaveBeenCalledTimes(2)
  expect(onStatusChange).not.toHaveBeenCalledWith("saved")
  resolvers[1]?.()
  await act(async () => {})
  expect(onStatusChange).toHaveBeenLastCalledWith("saved")
})
