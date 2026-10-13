import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBlurWatch } from "@/lib/blur-watch"

const CONFIRM_MS = 1_500

function setup(initial: { hidden?: boolean; focused?: boolean } = {}) {
  const state = { hidden: initial.hidden ?? false, focused: initial.focused ?? false }
  const onLeave = vi.fn()
  const watch = createBlurWatch({
    confirmMs: CONFIRM_MS,
    isHidden: () => state.hidden,
    hasFocus: () => state.focused,
    onLeave,
  })
  return { state, onLeave, watch }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("createBlurWatch", () => {
  it("reports once focus has stayed away for the confirmation window", () => {
    const { onLeave, watch } = setup()
    watch.onBlur()

    vi.advanceTimersByTime(CONFIRM_MS - 1)
    expect(onLeave).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it("stays silent when the document went hidden — the tab switch is reported as TAB_HIDDEN instead", () => {
    const { state, onLeave, watch } = setup()
    // The production ordering: blur first, `hidden` only afterwards. Measured
    // 3ms apart in one session and 1.6s apart in another, which is why the old
    // code's `if (!document.hidden)` test at blur time reported both events.
    watch.onBlur()
    state.hidden = true
    watch.onHidden()

    vi.advanceTimersByTime(CONFIRM_MS * 2)
    expect(onLeave).not.toHaveBeenCalled()
  })

  it("stays silent when `hidden` flips without an onHidden call ever arriving", () => {
    const { state, onLeave, watch } = setup()
    watch.onBlur()
    state.hidden = true

    vi.advanceTimersByTime(CONFIRM_MS)
    expect(onLeave).not.toHaveBeenCalled()
  })

  it("stays silent when focus comes straight back — a click on SEB's own task bar", () => {
    const { onLeave, watch } = setup()
    watch.onBlur()

    vi.advanceTimersByTime(200)
    watch.onFocus()

    vi.advanceTimersByTime(CONFIRM_MS * 2)
    expect(onLeave).not.toHaveBeenCalled()
  })

  it("stays silent when focus returned without a focus event, e.g. a dialog that never fired one", () => {
    const { state, onLeave, watch } = setup()
    watch.onBlur()
    state.focused = true

    vi.advanceTimersByTime(CONFIRM_MS)
    expect(onLeave).not.toHaveBeenCalled()
  })

  it("restarts the window on a second blur rather than reporting twice", () => {
    const { onLeave, watch } = setup()
    watch.onBlur()
    vi.advanceTimersByTime(CONFIRM_MS - 100)
    watch.onBlur()

    vi.advanceTimersByTime(CONFIRM_MS - 1)
    expect(onLeave).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it("reports again for a genuinely separate departure", () => {
    const { onLeave, watch } = setup()
    watch.onBlur()
    vi.advanceTimersByTime(CONFIRM_MS)
    watch.onFocus()
    watch.onBlur()
    vi.advanceTimersByTime(CONFIRM_MS)

    expect(onLeave).toHaveBeenCalledTimes(2)
  })

  it("dispose cancels a pending report and is safe to repeat", () => {
    const { onLeave, watch } = setup()
    watch.onBlur()
    watch.dispose()
    watch.dispose()

    vi.advanceTimersByTime(CONFIRM_MS * 2)
    expect(onLeave).not.toHaveBeenCalled()
  })
})
