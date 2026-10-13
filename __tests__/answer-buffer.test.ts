import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createAnswerBuffer,
  createLocalAnswerBuffer,
  type AnswerBufferStorage,
} from "@/lib/answer-buffer"

const STORAGE_KEY = "openexam:pending:s1"

class FakeStorage implements AnswerBufferStorage {
  private map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  read(key: string): unknown {
    const raw = this.map.get(key)
    return raw === undefined ? null : JSON.parse(raw)
  }
}

class ThrowingStorage implements AnswerBufferStorage {
  getItem(): string | null {
    return null
  }

  setItem(): void {
    throw new Error("QuotaExceededError")
  }

  removeItem(): void {}
}

function freeText(text: string) {
  return { type: "FREE_TEXT", text }
}

describe("createAnswerBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("persists an enqueued answer to storage after the debounce and removes the key once empty", async () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })
    const content = freeText("hello")

    buffer.enqueue("q1", content)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()

    await vi.advanceTimersByTimeAsync(800)
    expect(storage.read(STORAGE_KEY)).toEqual({ q1: content })

    buffer.discardIfMatch("q1", content)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })

  it("restarts the debounce when the same question is edited again", async () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })

    buffer.enqueue("q1", freeText("first"))
    await vi.advanceTimersByTimeAsync(400)
    buffer.enqueue("q1", freeText("second"))
    await vi.advanceTimersByTimeAsync(400)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()

    await vi.advanceTimersByTimeAsync(400)
    expect(storage.read(STORAGE_KEY)).toEqual({ q1: freeText("second") })
  })

  it("replays pending answers over the server copy and exposes them for re-attempt", async () => {
    const storage = new FakeStorage()
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        q1: freeText("pending"),
        q3: freeText("crashed-before-save"),
      })
    )
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })
    const serverAnswers: Record<string, unknown> = {
      q1: freeText("server"),
      q2: freeText("server"),
    }
    const attempted: Array<[string, unknown]> = []

    buffer.replay((pending) => {
      for (const [qId, content] of pending) serverAnswers[qId] = content
    })
    expect(serverAnswers.q1).toEqual(freeText("pending"))
    expect(serverAnswers.q2).toEqual(freeText("server"))
    expect(serverAnswers.q3).toEqual(freeText("crashed-before-save"))

    for (const [qId, content] of buffer.entries())
      attempted.push([qId, content])
    expect(attempted).toEqual([
      ["q1", freeText("pending")],
      ["q3", freeText("crashed-before-save")],
    ])
  })

  it("retries failing entries on each interval and discards them once saved", async () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage,
      retryIntervalMs: 10_000,
      // Pins the retry jitter to the middle of its range, i.e. exactly
      // retryIntervalMs, so the fake-timer advances below stay exact.
      random: () => 0.5,
    })
    const c1 = freeText("one")
    const c2 = freeText("two")
    const results = new Map<string, boolean>([
      ["q1", false],
      ["q2", false],
    ])
    const attempt = vi.fn(
      async (questionId: string) => results.get(questionId) ?? false
    )

    buffer.enqueue("q1", c1)
    buffer.enqueue("q2", c2)
    buffer.startRetryLoop(attempt)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(buffer.get("q1")).toBe(c1)
    expect(buffer.get("q2")).toBe(c2)

    results.set("q1", true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(buffer.get("q1")).toBeUndefined()
    expect(buffer.get("q2")).toBe(c2)

    buffer.stopRetryLoop()
    const calls = attempt.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(attempt.mock.calls.length).toBe(calls)
  })

  it("scatters the retry period so a cohort's retries don't stay in lockstep", async () => {
    const storage = new FakeStorage()
    // random() === 0 is the bottom of the jitter range: 25% early.
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage,
      retryIntervalMs: 10_000,
      random: () => 0,
    })
    const attempt = vi.fn(async () => false)

    buffer.enqueue("q1", freeText("one"))
    buffer.startRetryLoop(attempt)

    await vi.advanceTimersByTimeAsync(7_400)
    expect(attempt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(attempt).toHaveBeenCalledTimes(1)

    buffer.stopRetryLoop()
  })

  it("stops retrying after maxRetries consecutive failed cycles and resets on a clean cycle", async () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage,
      retryIntervalMs: 1_000,
      maxRetries: 2,
      random: () => 0.5,
    })
    let fail = true
    const attempt = vi.fn(async () => !fail)

    buffer.enqueue("q1", freeText("one"))
    buffer.startRetryLoop(attempt)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempt).toHaveBeenCalledTimes(1)

    fail = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(buffer.get("q1")).toBeUndefined()

    fail = true
    const c2 = freeText("two")
    buffer.enqueue("q2", c2)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempt).toHaveBeenCalledTimes(4)

    const calls = attempt.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempt.mock.calls.length).toBe(calls)
    expect(buffer.get("q2")).toBe(c2)
  })

  it("keeps retrying after an attempt that never settles", async () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage,
      retryIntervalMs: 1_000,
      attemptTimeoutMs: 5_000,
      random: () => 0.5,
    })
    // First attempt hangs forever (a fetch on a half-open connection), the
    // next one succeeds.
    const attempt = vi
      .fn<(questionId: string, content: unknown) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise<boolean>(() => {}))
      .mockResolvedValue(true)

    buffer.enqueue("q1", freeText("one"))
    buffer.startRetryLoop(attempt)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempt).toHaveBeenCalledTimes(1)
    // Still waiting on the hung attempt: no second cycle yet.
    await vi.advanceTimersByTimeAsync(4_000)
    expect(attempt).toHaveBeenCalledTimes(1)

    // Timed out at 5s; the next cycle runs one interval later and saves.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(buffer.get("q1")).toBeUndefined()
    buffer.destroy()
  })

  it("flushes all entries and keeps the ones that failed", async () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })
    const c1 = freeText("one")
    const c2 = freeText("two")
    const attempt = vi.fn(async (questionId: string) => questionId !== "q2")

    buffer.enqueue("q1", c1)
    buffer.enqueue("q2", c2)
    const results = await buffer.flush(attempt)

    expect(results).toEqual([
      ["q1", true],
      ["q2", false],
    ])
    expect(buffer.get("q1")).toBeUndefined()
    expect(buffer.get("q2")).toBe(c2)
  })

  it("does not clear an entry when a newer edit arrived (identity check)", () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })
    const oldContent = freeText("old")

    buffer.enqueue("q1", oldContent)
    const newer = freeText("newer")
    buffer.enqueue("q1", newer)

    buffer.discardIfMatch("q1", oldContent)
    expect(buffer.get("q1")).toBe(newer)

    buffer.discard("q1")
    expect(buffer.get("q1")).toBeUndefined()
  })

  it("keeps working in memory when storage writes throw", async () => {
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage: new ThrowingStorage(),
    })
    const content = freeText("one")

    buffer.enqueue("q1", content)
    await vi.advanceTimersByTimeAsync(800)
    expect(buffer.get("q1")).toBe(content)

    const results = await buffer.flush(vi.fn(async () => true))
    expect(results).toEqual([["q1", true]])
    expect(buffer.get("q1")).toBeUndefined()
  })

  it("treats a corrupted or non-object stored record as empty", () => {
    const storage = new FakeStorage()
    storage.setItem(STORAGE_KEY, "{definitely not json")
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })
    let seen: Array<[string, unknown]> | null = null

    buffer.replay((pending) => {
      seen = pending
    })
    expect(seen).toEqual([])

    const arrayStorage = new FakeStorage()
    arrayStorage.setItem(STORAGE_KEY, JSON.stringify(["not", "a", "record"]))
    const arrayBuffer = createAnswerBuffer({
      sessionId: "s1",
      storage: arrayStorage,
    })
    let arraySeen: Array<[string, unknown]> | null = null
    arrayBuffer.replay((pending) => {
      arraySeen = pending
    })
    expect(arraySeen).toEqual([])
  })

  it("persistNow writes the current record immediately without waiting for the debounce", () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({ sessionId: "s1", storage })
    const content = freeText("one")

    buffer.enqueue("q1", content)
    buffer.persistNow()
    expect(storage.read(STORAGE_KEY)).toEqual({ q1: content })

    buffer.clearAll()
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
    expect(buffer.entries()).toEqual([])
  })

  it("uses a custom keyPrefix when configured", () => {
    const storage = new FakeStorage()
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage,
      keyPrefix: "custom:prefix",
    })
    buffer.enqueue("q1", freeText("one"))
    buffer.persistNow()
    expect(storage.read("custom:prefix:s1")).toEqual({ q1: freeText("one") })
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
  })
})

// The exam runner builds its buffer with the lazy-ref idiom, which runs while
// the component renders — and Next.js renders "use client" components on the
// server too. Reading localStorage there threw and broke SSR of the exam page
// entirely, so this helper must hand back null rather than touch it.
describe("createLocalAnswerBuffer", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it("returns null when localStorage is absent (server render)", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(createLocalAnswerBuffer("s1")).toBeNull()
  })

  it("returns null when reading localStorage throws (storage denied)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: storage is disabled")
      },
    })
    expect(createLocalAnswerBuffer("s1")).toBeNull()
  })

  it("returns a working buffer when localStorage is available", () => {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
    const buffer = createLocalAnswerBuffer("s1")
    expect(buffer).not.toBeNull()
    buffer?.enqueue("q1", freeText("one"))
    buffer?.persistNow()
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "null")).toEqual({
      q1: freeText("one"),
    })
  })
})

describe("tab-scoped records", () => {
  class EnumerableStorage extends FakeStorage {
    keys = new Set<string>()
    get length() {
      return this.keys.size
    }
    key(index: number): string | null {
      return Array.from(this.keys)[index] ?? null
    }
    override setItem(key: string, value: string): void {
      this.keys.add(key)
      super.setItem(key, value)
    }
    override removeItem(key: string): void {
      this.keys.delete(key)
      super.removeItem(key)
    }
  }

  const text = (t: string) => ({ type: "FREE_TEXT", text: t })

  function bufferFor(storage: EnumerableStorage, tabId: string) {
    return createAnswerBuffer({ sessionId: "s1", storage, tabId })
  }

  function replayed(storage: EnumerableStorage, tabId: string) {
    let pending: Array<[string, unknown]> = []
    bufferFor(storage, tabId).replay((p) => (pending = p))
    return Object.fromEntries(pending)
  }

  it("keeps each tab's edits under its own key", () => {
    const storage = new EnumerableStorage()
    const a = bufferFor(storage, "tab-a")
    const b = bufferFor(storage, "tab-b")
    a.enqueue("q1", text("from a"))
    b.enqueue("q2", text("from b"))
    a.persistNow()
    b.persistNow()
    expect(storage.read(`${STORAGE_KEY}:tab-a`)).toEqual({ q1: text("from a") })
    expect(storage.read(`${STORAGE_KEY}:tab-b`)).toEqual({ q2: text("from b") })
  })

  it("does not replay a replaced tab's edits in the owning tab", () => {
    const storage = new EnumerableStorage()
    const replacedTab = bufferFor(storage, "tab-a")
    replacedTab.enqueue("q1", text("stale edit after takeover"))
    replacedTab.persistNow()
    replacedTab.markReplaced()

    expect(replayed(storage, "tab-b")).toEqual({})
    // It stays the replaced tab's own for a reclaim.
    expect(replayed(storage, "tab-a")).toEqual({
      q1: text("stale edit after takeover"),
    })
  })

  it("adopts the record of a tab that is gone, own edits winning", () => {
    const storage = new EnumerableStorage()
    storage.setItem(
      `${STORAGE_KEY}:tab-crashed`,
      JSON.stringify({ q1: text("crashed q1"), q2: text("crashed q2") })
    )
    storage.setItem(
      `${STORAGE_KEY}:tab-b`,
      JSON.stringify({ q2: text("own q2") })
    )
    expect(replayed(storage, "tab-b")).toEqual({
      q1: text("crashed q1"),
      q2: text("own q2"),
    })
    expect(storage.getItem(`${STORAGE_KEY}:tab-crashed`)).toBeNull()
    expect(storage.read(`${STORAGE_KEY}:tab-b`)).toEqual({
      q1: text("crashed q1"),
      q2: text("own q2"),
    })
  })

  it("adopts a record written before records were scoped by tab", () => {
    const storage = new EnumerableStorage()
    storage.setItem(STORAGE_KEY, JSON.stringify({ q1: text("legacy") }))
    // Another session whose id extends this one's is not adopted.
    storage.setItem(`${STORAGE_KEY}0`, JSON.stringify({ q9: text("other") }))
    expect(replayed(storage, "tab-b")).toEqual({ q1: text("legacy") })
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
    expect(storage.getItem(`${STORAGE_KEY}0`)).not.toBeNull()
  })

  it("resolves a lazy tab identity when the record is first used", () => {
    const storage = new EnumerableStorage()
    let tabId = "tab-copied"
    const buffer = createAnswerBuffer({
      sessionId: "s1",
      storage,
      tabId: () => tabId,
    })
    tabId = "tab-minted"
    buffer.enqueue("q1", text("edit"))
    buffer.persistNow()
    expect(storage.read(`${STORAGE_KEY}:tab-minted`)).toEqual({
      q1: text("edit"),
    })
  })

  it("clears the replaced marker with the record after submit", () => {
    const storage = new EnumerableStorage()
    const buffer = bufferFor(storage, "tab-a")
    buffer.markReplaced()
    buffer.clearAll()
    expect(storage.getItem(`${STORAGE_KEY}:tab-a:replaced`)).toBeNull()
  })
})
