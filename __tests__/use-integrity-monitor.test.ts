// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useIntegrityMonitor } from "@/hooks/use-integrity-monitor"

function setup(enabled = true) {
  const onEvent = vi.fn()
  const hook = renderHook(
    (p: { enabled: boolean; onEvent: typeof onEvent }) =>
      useIntegrityMonitor(p),
    { initialProps: { enabled, onEvent } }
  )
  return { ...hook, onEvent }
}

function fire(target: EventTarget, event: Event) {
  target.dispatchEvent(event)
  return event
}

function key(init: KeyboardEventInit, target: EventTarget = document) {
  return fire(
    target,
    new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init })
  )
}

function clipboard(
  type: "copy" | "paste" | "cut",
  target: EventTarget = document
) {
  return fire(target, new Event(type, { cancelable: true, bubbles: true }))
}

let hidden = false
let focused = true

beforeEach(() => {
  vi.useFakeTimers()
  hidden = false
  focused = true
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden)
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused)
  // A normal browser window: no devtools-sized chrome delta.
  vi.spyOn(window, "outerWidth", "get").mockReturnValue(window.innerWidth)
  vi.spyOn(window, "outerHeight", "get").mockReturnValue(window.innerHeight)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
  delete (window as { SafeExamBrowser?: unknown }).SafeExamBrowser
})

describe("clipboard", () => {
  it.each([
    ["copy", "COPY_BLOCKED", undefined],
    ["paste", "PASTE_BLOCKED", undefined],
    ["cut", "COPY_BLOCKED", "cut"],
  ] as const)("blocks and reports %s on exam content", (type, kind, detail) => {
    const { onEvent } = setup()
    const e = clipboard(type)
    expect(e.defaultPrevented).toBe(true)
    expect(onEvent).toHaveBeenCalledWith(kind, detail)
  })

  it.each(["input", "textarea"])(
    "leaves clipboard use inside an answer %s alone",
    (tag) => {
      const { onEvent } = setup()
      const field = document.body.appendChild(document.createElement(tag))
      for (const type of ["copy", "paste", "cut"] as const) {
        expect(clipboard(type, field).defaultPrevented).toBe(false)
      }
      expect(onEvent).not.toHaveBeenCalled()
    }
  )

  it("treats contenteditable (the rich-text editor) as an answer field", () => {
    const { onEvent } = setup()
    const div = document.body.appendChild(document.createElement("div"))
    div.contentEditable = "true"
    // happy-dom does not derive isContentEditable from the attribute.
    Object.defineProperty(div, "isContentEditable", { value: true })
    expect(clipboard("paste", div).defaultPrevented).toBe(false)
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe("keyboard shortcuts", () => {
  it.each([
    [{ key: "c", ctrlKey: true }, "COPY_BLOCKED", "shortcut"],
    [{ key: "C", metaKey: true }, "COPY_BLOCKED", "shortcut"],
    [{ key: "v", ctrlKey: true }, "PASTE_BLOCKED", "shortcut"],
    [{ key: "x", metaKey: true }, "COPY_BLOCKED", "cut-shortcut"],
    [{ key: "F12" }, "SHORTCUT_BLOCKED", "F12"],
    [
      { key: "I", ctrlKey: true, shiftKey: true },
      "SHORTCUT_BLOCKED",
      "devtools:i",
    ],
    [
      { key: "j", metaKey: true, shiftKey: true },
      "SHORTCUT_BLOCKED",
      "devtools:j",
    ],
    [
      { key: "C", ctrlKey: true, shiftKey: true },
      "SHORTCUT_BLOCKED",
      "devtools:c",
    ],
    [{ key: "u", ctrlKey: true }, "SHORTCUT_BLOCKED", "view-source"],
  ] as const)("blocks %o as %s/%s", (init, kind, detail) => {
    const { onEvent } = setup()
    expect(key(init).defaultPrevented).toBe(true)
    expect(onEvent).toHaveBeenCalledWith(kind, detail)
  })

  it("allows copy/paste/cut shortcuts inside an answer field", () => {
    const { onEvent } = setup()
    const input = document.body.appendChild(document.createElement("input"))
    for (const k of ["c", "v", "x"]) {
      expect(key({ key: k, ctrlKey: true }, input).defaultPrevented).toBe(false)
    }
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("still blocks devtools shortcuts inside an answer field", () => {
    const { onEvent } = setup()
    const input = document.body.appendChild(document.createElement("input"))
    expect(key({ key: "F12" }, input).defaultPrevented).toBe(true)
    expect(onEvent).toHaveBeenCalledWith("SHORTCUT_BLOCKED", "F12")
  })

  it("ignores ordinary typing", () => {
    const { onEvent } = setup()
    expect(key({ key: "c" }).defaultPrevented).toBe(false)
    expect(key({ key: "Enter" }).defaultPrevented).toBe(false)
    expect(onEvent).not.toHaveBeenCalled()
  })
})

it("blocks and reports the context menu", () => {
  const { onEvent } = setup()
  const e = fire(document, new MouseEvent("contextmenu", { cancelable: true }))
  expect(e.defaultPrevented).toBe(true)
  expect(onEvent).toHaveBeenCalledWith("CONTEXT_MENU_BLOCKED", undefined)
})

describe("focus loss", () => {
  it("reports a tab switch once, not also as a window blur", () => {
    const { onEvent } = setup()
    focused = false
    fire(window, new Event("blur"))
    hidden = true
    fire(document, new Event("visibilitychange"))
    vi.advanceTimersByTime(5_000)
    expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
  })

  it("ignores visibilitychange back to visible", () => {
    const { onEvent } = setup()
    fire(document, new Event("visibilitychange"))
    expect(onEvent).not.toHaveBeenCalled()
  })

  it("reports a window blur only once it has lasted 1.5s", () => {
    const { onEvent } = setup()
    focused = false
    fire(window, new Event("blur"))
    vi.advanceTimersByTime(1_499)
    expect(onEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onEvent).toHaveBeenCalledWith("WINDOW_BLUR", undefined)
  })

  describe("reload (F5)", () => {
    // Set by hand: happy-dom's PageTransitionEvent drops `persisted`, and a
    // test can only dispatch untrusted events.
    function trusted<E extends Event>(e: E, isTrusted = true) {
      Object.defineProperty(e, "isTrusted", { value: isTrusted })
      return e
    }

    function pagehide({ persisted = false, isTrusted = true } = {}) {
      const e = new Event("pagehide")
      Object.defineProperty(e, "persisted", { value: persisted })
      fire(window, trusted(e, isTrusted))
    }

    function pageshow({ persisted = true } = {}) {
      const e = new Event("pageshow")
      Object.defineProperty(e, "persisted", { value: persisted })
      fire(window, trusted(e))
    }

    function reloadKey(
      init: KeyboardEventInit = { key: "F5" },
      isTrusted = true
    ) {
      fire(
        document,
        trusted(
          new KeyboardEvent("keydown", {
            cancelable: true,
            bubbles: true,
            ...init,
          }),
          isTrusted
        )
      )
    }

    function hide() {
      hidden = true
      fire(document, new Event("visibilitychange"))
    }

    it.each([
      ["F5", { key: "F5" }],
      ["Ctrl+R", { key: "r", ctrlKey: true }],
      ["Cmd+Shift+R", { key: "R", metaKey: true, shiftKey: true }],
    ])("does not block %s", (_, init) => {
      const e = key(init)
      expect(e.defaultPrevented).toBe(false)
    })

    it("does not report the hide of a reload, visibilitychange first", () => {
      const { onEvent } = setup()
      reloadKey()
      hide()
      pagehide()
      vi.advanceTimersByTime(5_000)
      expect(onEvent).not.toHaveBeenCalled()
    })

    it("does not report the hide of a reload, pagehide first", () => {
      const { onEvent } = setup()
      reloadKey({ key: "r", ctrlKey: true })
      pagehide()
      hide()
      vi.advanceTimersByTime(5_000)
      expect(onEvent).not.toHaveBeenCalled()
    })

    it("drops a pending window blur once the page reloads", () => {
      const { onEvent } = setup()
      reloadKey()
      focused = false
      fire(window, new Event("blur"))
      vi.advanceTimersByTime(1_000)
      pagehide()
      vi.advanceTimersByTime(5_000)
      expect(onEvent).not.toHaveBeenCalled()
    })

    it("still reports a tab switch shortly after a reload key", () => {
      const { onEvent } = setup()
      reloadKey()
      hide()
      vi.advanceTimersByTime(0)
      expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
    })

    it("reports a tab switch synchronously without a reload key", () => {
      const { onEvent } = setup()
      hide()
      expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
    })

    it("treats a stale reload key as no reload", () => {
      const { onEvent } = setup()
      reloadKey()
      vi.advanceTimersByTime(10_000)
      hide()
      pagehide()
      expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
    })

    it("ignores a script-dispatched reload key", () => {
      const { onEvent } = setup()
      reloadKey({ key: "F5" }, false)
      hide()
      pagehide()
      expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
    })

    describe.each(["visibilitychange first", "pagehide first"])(
      "%s",
      (order) => {
        function leave(persisted: boolean) {
          if (order === "visibilitychange first") {
            hide()
            pagehide({ persisted })
          } else {
            pagehide({ persisted })
            hide()
          }
        }

        it("reports closing the tab or navigating away before unload", () => {
          const { onEvent } = setup()
          leave(false)
          // No timer advance: a timer would never run during unload.
          expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
        })

        it("reports leaving into the back/forward cache before suspension", () => {
          const { onEvent } = setup()
          reloadKey()
          leave(true)
          expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
          // Restored later: no duplicate from a timer that outlived the
          // throttle while the page was frozen.
          vi.advanceTimersByTime(60_000)
          pageshow()
          vi.advanceTimersByTime(5_000)
          expect(onEvent).toHaveBeenCalledTimes(1)
        })
      }
    )

    it("reports again after a back/forward cache restore", () => {
      const { onEvent } = setup()
      hide()
      pagehide({ persisted: true })
      vi.advanceTimersByTime(60_000)
      hidden = false
      pageshow()
      reloadKey()
      hide()
      pagehide()
      vi.advanceTimersByTime(5_000)
      expect(onEvent).toHaveBeenCalledTimes(1)
    })

    it("ignores a script-dispatched pagehide", () => {
      // Otherwise one dispatchEvent from devtools would mute every later
      // tab switch for the rest of the exam.
      const { onEvent } = setup()
      reloadKey()
      pagehide({ isTrusted: false })
      hide()
      vi.advanceTimersByTime(0)
      expect(onEvent.mock.calls).toEqual([["TAB_HIDDEN", undefined]])
    })
  })

  it("drops a brief blur that regains focus in time", () => {
    const { onEvent } = setup()
    focused = false
    fire(window, new Event("blur"))
    vi.advanceTimersByTime(500)
    focused = true
    fire(window, new Event("focus"))
    vi.advanceTimersByTime(5_000)
    expect(onEvent).not.toHaveBeenCalled()
  })
})

describe("devtools heuristic", () => {
  it("flags a large outer/inner size delta", () => {
    vi.spyOn(window, "outerWidth", "get").mockReturnValue(
      window.innerWidth + 400
    )
    const { onEvent } = setup()
    vi.advanceTimersByTime(1_000)
    expect(onEvent).toHaveBeenCalledWith("DEVTOOLS_SUSPECTED", undefined)
  })

  it("does not poll inside SEB, where the size delta is meaningless", () => {
    ;(window as { SafeExamBrowser?: unknown }).SafeExamBrowser = {}
    vi.spyOn(window, "outerHeight", "get").mockReturnValue(
      window.innerHeight + 400
    )
    const { onEvent } = setup()
    vi.advanceTimersByTime(10_000)
    expect(onEvent).not.toHaveBeenCalled()
  })
})

it("throttles reports per kind to one every 2s, without throttling the block", () => {
  const { onEvent } = setup()
  expect(clipboard("copy").defaultPrevented).toBe(true)
  vi.advanceTimersByTime(1_999)
  expect(clipboard("copy").defaultPrevented).toBe(true)
  // A different kind is not throttled by the first.
  clipboard("paste")
  expect(onEvent.mock.calls).toEqual([
    ["COPY_BLOCKED", undefined],
    ["PASTE_BLOCKED", undefined],
  ])
  vi.advanceTimersByTime(1)
  clipboard("copy")
  expect(onEvent).toHaveBeenCalledTimes(3)
})

it("calls the latest onEvent without re-subscribing", () => {
  const { rerender, onEvent } = setup()
  const next = vi.fn()
  rerender({ enabled: true, onEvent: next })
  clipboard("copy")
  expect(onEvent).not.toHaveBeenCalled()
  expect(next).toHaveBeenCalledWith("COPY_BLOCKED", undefined)
})

it("does nothing while disabled", () => {
  const { onEvent } = setup(false)
  expect(clipboard("copy").defaultPrevented).toBe(false)
  expect(key({ key: "F12" }).defaultPrevented).toBe(false)
  expect(onEvent).not.toHaveBeenCalled()
})

it("removes every listener and timer on unmount", () => {
  const { unmount, onEvent } = setup()
  unmount()
  expect(clipboard("copy").defaultPrevented).toBe(false)
  fire(document, new MouseEvent("contextmenu", { cancelable: true }))
  focused = false
  fire(window, new Event("blur"))
  vi.advanceTimersByTime(10_000)
  expect(onEvent).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
