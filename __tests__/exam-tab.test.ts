// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest"

const STORED_ID = "11111111-1111-4111-8111-111111111111"

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function documentWithNavigation(type: "navigate" | "reload") {
  vi.resetModules()
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    { type } as PerformanceNavigationTiming,
  ])
  return import("@/lib/exam-tab")
}

it("gives a new document a new ID even when sessionStorage was copied", async () => {
  sessionStorage.setItem("openexam.examTabId", STORED_ID)
  const { getExamTabId } = await documentWithNavigation("navigate")
  const id = getExamTabId()
  expect(id).not.toBe(STORED_ID)
  expect(id).toMatch(/^[0-9a-f-]{36}$/i)
  expect(getExamTabId()).toBe(id)
  expect(sessionStorage.getItem("openexam.examTabId")).toBe(id)
})

it("keeps the tab ID across a page reload", async () => {
  sessionStorage.setItem("openexam.examTabId", STORED_ID)
  const { getExamTabId } = await documentWithNavigation("reload")
  expect(getExamTabId()).toBe(STORED_ID)
})

it("adds the tab ID to session requests even without SEB", async () => {
  const fetcher = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => new Response("{}"))
  vi.stubGlobal("fetch", fetcher)
  const { getExamTabId } = await documentWithNavigation("navigate")
  const { sebFetch } = await import("@/lib/seb-client")

  await sebFetch("/api/sessions/s1/answers", { method: "PUT" })
  const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
  expect(headers.get("x-openexam-device-id")).toBe(getExamTabId())

  await sebFetch("/api/exams/e1")
  const unrelatedHeaders = new Headers(fetcher.mock.calls[1][1]?.headers)
  expect(unrelatedHeaders.has("x-openexam-device-id")).toBe(false)
})

it("preserves Request headers while adding the tab identity", async () => {
  const fetcher = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async () => new Response("{}"))
  vi.stubGlobal("fetch", fetcher)
  const { getExamTabId } = await documentWithNavigation("navigate")
  const { sebFetch } = await import("@/lib/seb-client")
  await sebFetch(
    new Request(new URL("/api/sessions/s1/answers", window.location.origin), {
      headers: { "content-type": "application/json" },
    })
  )
  const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
  expect(headers.get("content-type")).toBe("application/json")
  expect(headers.get("x-openexam-device-id")).toBe(getExamTabId())
})

function fakeLocks() {
  const held = new Set<string>()
  return {
    held,
    request: vi.fn(
      (
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown> | unknown
      ) => {
        if (!held.has(name)) {
          held.add(name)
          return Promise.resolve(callback({ name, mode: "exclusive" }))
        }
        if (options.ifAvailable) return Promise.resolve(callback(null))
        return new Promise((_, reject) =>
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          )
        )
      }
    ),
  }
}

it("keeps a stored identity no other live tab holds", async () => {
  const locks = fakeLocks()
  vi.stubGlobal("navigator", { ...navigator, locks })
  sessionStorage.setItem("openexam.examTabId", STORED_ID)
  const { ensureExclusiveExamTabId, getExamTabId } =
    await documentWithNavigation("navigate")
  expect(await ensureExclusiveExamTabId(10)).toBe(STORED_ID)
  expect(getExamTabId()).toBe(STORED_ID)
  expect(locks.held).toContain(`openexam-exam-tab:${STORED_ID}`)
})

it("mints a new identity when a live duplicate holds the copied one", async () => {
  const locks = fakeLocks()
  // The original tab still runs the exam under the identity both share.
  locks.held.add(`openexam-exam-tab:${STORED_ID}`)
  vi.stubGlobal("navigator", { ...navigator, locks })
  sessionStorage.setItem("openexam.examTabId", STORED_ID)
  // A duplicate reloaded before opening the exam reports "reload" too.
  const { ensureExclusiveExamTabId, getExamTabId } =
    await documentWithNavigation("reload")
  const id = await ensureExclusiveExamTabId(10)
  expect(id).not.toBe(STORED_ID)
  expect(getExamTabId()).toBe(id)
  expect(sessionStorage.getItem("openexam.examTabId")).toBe(id)
  expect(locks.held).toContain(`openexam-exam-tab:${id}`)
})
