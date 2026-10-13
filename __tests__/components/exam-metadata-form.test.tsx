// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"
import { ExamMetadataForm } from "@/components/exams/exam-metadata-form"
import { TooltipProvider } from "@/components/ui/tooltip"

const START = "2026-10-07T12:30:00.000Z"
const END = "2026-10-07T14:00:00.000Z"

function renderForm(onSubmit = vi.fn()) {
  render(
    <TooltipProvider>
      <ExamMetadataForm
        autosave
        onSubmit={onSubmit}
        defaultValues={{
          title: "Prüfung",
          timeLimitMin: 30,
          scheduledStart: START,
          scheduledEnd: END,
        }}
      />
    </TooltipProvider>
  )
  return onSubmit
}

it("shows and edits the schedule in Swiss time, whatever the browser zone", async () => {
  const onSubmit = renderForm()
  const [startTime, endTime] = screen.getAllByLabelText("Uhrzeit")
  // 12:30 UTC is 14:30 in Zurich (CEST)
  expect((startTime as HTMLInputElement).value).toBe("14:30")
  expect((endTime as HTMLInputElement).value).toBe("16:00")
  expect(screen.getAllByText("07.10.2026")).toHaveLength(2)

  fireEvent.change(endTime, { target: { value: "17:15" } })
  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  expect(onSubmit.mock.calls.at(-1)?.[0]).toMatchObject({
    scheduledStart: START,
    scheduledEnd: "2026-10-07T15:15:00.000Z",
  })
})

it("says why an end before the start is not saved", async () => {
  const onSubmit = renderForm()
  const [, endTime] = screen.getAllByLabelText("Uhrzeit")
  fireEvent.change(endTime, { target: { value: "13:00" } })

  expect(
    await screen.findByText(
      "Geplantes Ende muss nach dem geplanten Start liegen"
    )
  ).toBeTruthy()
  expect(onSubmit).not.toHaveBeenCalled()
})

it("removes a scheduled start so autosave sends null", async () => {
  const onSubmit = renderForm()
  fireEvent.click(
    screen.getByRole("button", { name: "Geplanter Start entfernen" })
  )

  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  expect(onSubmit.mock.calls.at(-1)?.[0]).toMatchObject({
    scheduledStart: null,
    scheduledEnd: END,
  })
  expect(screen.getAllByText("Datum wählen")).toHaveLength(1)
})

it("turning on the shared start clears the end and every save keeps it on", async () => {
  const onSubmit = renderForm(vi.fn().mockResolvedValue(undefined))
  fireEvent.click(screen.getByRole("switch", { name: /Gemeinsamer Start/ }))

  await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  // Past the 600 ms autosave debounce: a save queued with the values from
  // before the switch used to land here and turn it back off.
  await new Promise((resolve) => setTimeout(resolve, 900))
  for (const [data] of onSubmit.mock.calls) {
    expect(data).toMatchObject({ waitingRoom: true, scheduledEnd: null })
  }
  expect(screen.getByText("Warteraum öffnet ab")).toBeTruthy()
  expect(screen.queryByText("Geplantes Ende")).toBeNull()
})
