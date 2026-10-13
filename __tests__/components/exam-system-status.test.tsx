// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ExamSystemStatus } from "@/components/exam-taking/exam-system-status"

class FakeBattery extends EventTarget {
  constructor(
    public level: number,
    public charging: boolean
  ) {
    super()
  }
  set(level: number, charging = this.charging) {
    this.level = level
    this.charging = charging
    this.dispatchEvent(new Event("levelchange"))
  }
}

function enterSeb() {
  ;(window as { SafeExamBrowser?: unknown }).SafeExamBrowser = {}
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-06-01T08:30:00Z"))
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as { SafeExamBrowser?: unknown }).SafeExamBrowser
  delete (navigator as { getBattery?: unknown }).getBattery
})

/** Flush the getBattery() promise. */
async function settle() {
  await act(async () => {})
}

it("renders nothing outside SEB, where the OS task bar is still visible", () => {
  const { container } = render(
    <ExamSystemStatus clockOffsetMs={0} connected={false} />
  )
  expect(container).toBeEmptyDOMElement()
})

describe("inside SEB", () => {
  beforeEach(enterSeb)

  it("shows the wall-clock time corrected by the server offset", () => {
    const offset = 90 * 60 * 1000
    const expected = new Date(Date.now() + offset).toLocaleTimeString("de-CH", {
      hour: "2-digit",
      minute: "2-digit",
    })
    render(<ExamSystemStatus clockOffsetMs={offset} connected />)
    expect(screen.getByLabelText(`Uhrzeit ${expected}`)).toHaveTextContent(
      expected
    )
  })

  it("only shows Offline after the socket has been down for 5s", () => {
    const { rerender } = render(
      <ExamSystemStatus clockOffsetMs={0} connected />
    )
    rerender(<ExamSystemStatus clockOffsetMs={0} connected={false} />)
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.queryByText("Offline")).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText("Offline")).toBeInTheDocument()
  })

  it("never flashes Offline for a brief reconnect, and clears instantly on recovery", () => {
    const { rerender } = render(
      <ExamSystemStatus clockOffsetMs={0} connected={false} />
    )
    act(() => vi.advanceTimersByTime(3_000))
    rerender(<ExamSystemStatus clockOffsetMs={0} connected />)
    rerender(<ExamSystemStatus clockOffsetMs={0} connected={false} />)
    // The 5s window restarted with the second drop.
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.queryByText("Offline")).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText("Offline")).toBeInTheDocument()

    rerender(<ExamSystemStatus clockOffsetMs={0} connected />)
    expect(screen.queryByText("Offline")).not.toBeInTheDocument()
  })

  it("shows the battery level and follows level/charging changes", async () => {
    const battery = new FakeBattery(0.85, false)
    navigator.getBattery = () => Promise.resolve(battery)
    render(<ExamSystemStatus clockOffsetMs={0} connected />)
    await settle()
    expect(screen.getByLabelText("Akku 85 Prozent")).toHaveTextContent("85%")

    act(() => battery.set(0.08))
    expect(screen.getByLabelText("Akku 8 Prozent")).toBeInTheDocument()

    act(() => {
      battery.charging = true
      battery.dispatchEvent(new Event("chargingchange"))
    })
    expect(
      screen.getByLabelText("Akku 8 Prozent, wird geladen")
    ).toBeInTheDocument()
  })

  it("renders no battery where the API is missing or rejects", async () => {
    render(<ExamSystemStatus clockOffsetMs={0} connected />)
    await settle()
    expect(screen.queryByLabelText(/^Akku/)).not.toBeInTheDocument()

    navigator.getBattery = () => Promise.reject(new Error("policy"))
    render(<ExamSystemStatus clockOffsetMs={0} connected />)
    await settle()
    expect(screen.queryByLabelText(/^Akku/)).not.toBeInTheDocument()
  })

  it("detaches battery listeners on unmount", async () => {
    const battery = new FakeBattery(0.5, false)
    const remove = vi.spyOn(battery, "removeEventListener")
    navigator.getBattery = () => Promise.resolve(battery)
    const { unmount } = render(<ExamSystemStatus clockOffsetMs={0} connected />)
    await settle()
    unmount()
    expect(remove.mock.calls.map((c) => c[0]).sort()).toEqual([
      "chargingchange",
      "levelchange",
    ])
  })

  it("does not subscribe if unmounted before getBattery resolves", async () => {
    const battery = new FakeBattery(0.5, false)
    const add = vi.spyOn(battery, "addEventListener")
    let resolve!: (b: FakeBattery) => void
    navigator.getBattery = () => new Promise((r) => (resolve = r))
    const { unmount } = render(<ExamSystemStatus clockOffsetMs={0} connected />)
    unmount()
    await act(async () => resolve(battery))
    expect(add).not.toHaveBeenCalled()
  })
})
