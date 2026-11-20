import { getLocalStorage } from "@/lib/safe-storage"
import { ANSWER_BUFFER_KEY_PREFIX } from "@/lib/storage-keys"

export type AnswerContent =
  | { type: "MULTIPLE_CHOICE"; selectedOptionIds: string[] }
  | { type: "FREE_TEXT"; text: string }
  | { type: "FILL_IN_THE_BLANK"; blanks: { id: string; value: string }[] }
  | { type: "FILE_UPLOAD"; fileKey: string; fileName: string }
  | { type: "MATCHING"; matches: { leftId: string; rightId: string }[] }
  | { type: "CODE"; code: string; language: string }
  | { type: "TRUE_FALSE"; selected: boolean }
  | { type: "SHORT_ANSWER"; text: string }
  | { type: "ORDERING"; orderedIds: string[] }

export interface AnswerBufferStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Key enumeration, as on Web Storage; needed to adopt other tabs' records. */
  readonly length?: number
  key?(index: number): string | null
}

export interface AnswerBufferOptions {
  sessionId: string
  storage: AnswerBufferStorage
  /**
   * Scopes the record to one browser tab (lib/exam-tab.ts). Tabs of the same
   * session must not share a record: each persist rewrites the whole record,
   * and a tab replaced by another one would otherwise replay its stale edits
   * over the owner's answers. See hydrate() for how records of tabs that are
   * gone (a crash, a closed tab) are still recovered.
   */
  tabId?: string | (() => string)
  keyPrefix?: string
  debounceMs?: number
  retryIntervalMs?: number
  maxRetries?: number
  now?: () => number
  /** Injectable for tests; production uses Math.random. See RETRY_JITTER. */
  random?: () => number
  /**
   * Longest a single retry attempt is waited on before the loop counts it as
   * failed and moves on. Defaults to 3x retryIntervalMs.
   */
  attemptTimeoutMs?: number
}

export interface AnswerBuffer<T = unknown> {
  enqueue(questionId: string, content: T): void
  entries(): Array<[string, T]>
  get(questionId: string): T | undefined
  discardIfMatch(questionId: string, content: T): void
  discard(questionId: string): void
  persistNow(): void
  clearAll(): void
  replay(load: (pending: Array<[string, T]>) => void): void
  /**
   * Flags this tab as replaced. From then on its edits persist under a
   * detached key, so the base record keeps exactly the pre-takeover edits
   * that the new owner may adopt, while later edits can never overwrite the
   * owner's answers. Cleared by clearReplaced() once this tab claims the
   * session back.
   */
  markReplaced(): void
  clearReplaced(): void
  startRetryLoop(
    attempt: (questionId: string, content: T) => Promise<boolean>
  ): () => void
  stopRetryLoop(): void
  flush(
    attempt: (questionId: string, content: T) => Promise<boolean>
  ): Promise<Array<[string, boolean]>>
  destroy(): void
}

const REPLACED_SUFFIX = ":replaced"
// After a tab is replaced, its further edits are persisted under this suffix
// instead of the record key: the record then holds only pre-takeover edits,
// which the new owner may still adopt, while post-takeover edits never
// overwrite the owner's answers.
const DETACHED_SUFFIX = ":detached"

// Fraction of retryIntervalMs the retry period is scattered over, so
// `random() === 0.5` reproduces the nominal interval exactly.
//
// Without it the whole cohort retries in lockstep: every client whose save
// failed does so because the server was overloaded, so a fixed period aims
// all of their retries at the same instant, every 10 s, for as long as the
// overload lasts. That is the thundering herd the exam-start queue
// (lib/exam-admission.ts) exists to prevent, rebuilt after the fact.
const RETRY_JITTER = 0.25

export function createAnswerBuffer<T = unknown>(
  options: AnswerBufferOptions
): AnswerBuffer<T> {
  const sessionKey = `${options.keyPrefix ?? ANSWER_BUFFER_KEY_PREFIX}:${options.sessionId}`
  // Resolved on each use: a tab can mint a new identity after the buffer is
  // created (lib/exam-tab.ts ensureExclusiveExamTabId), before any edit.
  const tabIdOf = (): string | undefined =>
    typeof options.tabId === "function" ? options.tabId() : options.tabId
  const keyOf = () => {
    const id = tabIdOf()
    return id ? `${sessionKey}:${id}` : sessionKey
  }
  const replacedKeyOf = () => `${keyOf()}${REPLACED_SUFFIX}`
  // Once replaced, this tab writes to a detached record: the base record
  // keeps exactly the pre-takeover edits for the new owner to adopt.
  let replaced = false
  const writeKeyOf = () => (replaced ? `${keyOf()}${DETACHED_SUFFIX}` : keyOf())
  const debounceMs = options.debounceMs ?? 800
  const retryIntervalMs = options.retryIntervalMs ?? 10_000
  const maxRetries = options.maxRetries ?? 0
  const random = options.random ?? Math.random
  const attemptTimeoutMs = options.attemptTimeoutMs ?? retryIntervalMs * 3

  const record = new Map<string, T>()
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let hydrated = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryRunning = false
  let failedCycles = 0

  function persistNow() {
    try {
      const key = writeKeyOf()
      if (record.size === 0) options.storage.removeItem(key)
      else
        options.storage.setItem(key, JSON.stringify(Object.fromEntries(record)))
    } catch {
      // Storage full/unavailable — autosave via network still applies.
    }
  }

  function readRecord(recordKey: string): Array<[string, T]> {
    try {
      const raw = options.storage.getItem(recordKey)
      if (raw === null) return []
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      )
        return Object.entries(parsed) as Array<[string, T]>
    } catch {
      // Storage inaccessible (disabled, SecurityError in private browsing,
      // etc.) or a corrupt record — degrade to an empty buffer instead of
      // crashing the load.
    }
    return []
  }

  // Records of this session's other tabs that can be adopted: a tab that
  // crashed or was closed with unsaved edits, a record written before
  // records were scoped by tab, or a REPLACED tab's base record, which holds
  // exactly its pre-takeover edits. That tab's DETACHED record (its
  // post-takeover edits) is adoptable only once the replaced marker is gone —
  // i.e. after the tab reclaimed the session — because until then those edits
  // must not overwrite the owner's answers. This tab's own record is excluded.
  function orphanedKeys(): string[] {
    const { storage } = options
    const key = keyOf()
    if (!tabIdOf() || storage.key === undefined) return []
    const keys: string[] = []
    try {
      for (let i = 0; i < (storage.length ?? 0); i++) {
        const k = storage.key(i)
        if (
          k === null ||
          k === key ||
          (k !== sessionKey && !k.startsWith(`${sessionKey}:`)) ||
          k.endsWith(REPLACED_SUFFIX)
        )
          continue
        if (k.endsWith(DETACHED_SUFFIX)) {
          const base = k.slice(0, -DETACHED_SUFFIX.length)
          if (storage.getItem(`${base}${REPLACED_SUFFIX}`) !== null) continue
        }
        keys.push(k)
      }
    } catch {
      return []
    }
    return keys
  }

  function hydrate() {
    if (hydrated) return
    hydrated = true
    const orphans = orphanedKeys()
    for (const orphan of orphans)
      for (const [questionId, content] of readRecord(orphan))
        record.set(questionId, content)
    // This tab's own edits are the newest local state and win.
    for (const [questionId, content] of readRecord(keyOf()))
      record.set(questionId, content)
    if (orphans.length === 0) return
    persistNow()
    try {
      for (const orphan of orphans) {
        options.storage.removeItem(orphan)
        // Adopted a replaced tab's pre-takeover record; its marker goes too.
        options.storage.removeItem(`${orphan}${REPLACED_SUFFIX}`)
      }
    } catch {
      // Adopted entries are persisted under this tab's key either way.
    }
  }

  function schedulePersist(questionId: string) {
    const existing = debounceTimers.get(questionId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      debounceTimers.delete(questionId)
      persistNow()
    }, debounceMs)
    debounceTimers.set(questionId, timer)
  }

  function discardIfMatch(questionId: string, content: T) {
    // A newer edit may have landed in the buffer while the save was in
    // flight — only clear it if it still holds what we just saved.
    if (record.get(questionId) === content) {
      record.delete(questionId)
      persistNow()
    }
  }

  function stopRetryLoop() {
    retryRunning = false
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  // Runs every attempt concurrently instead of one at a time, so N buffered
  // answers take as long as the slowest single save/WS timeout rather than
  // the sum of all of them. discardIfMatch still guards each entry
  // individually by identity, so a slow/late attempt for one question can
  // never clobber a newer edit that landed for it (or any other question)
  // while the batch was in flight.
  async function runAttempts(
    snapshot: Array<[string, T]>,
    attempt: (questionId: string, content: T) => Promise<boolean>
  ): Promise<Array<[string, boolean]>> {
    return Promise.all(
      snapshot.map(
        async ([questionId, content]): Promise<[string, boolean]> => {
          let ok = false
          try {
            ok = await attempt(questionId, content)
          } catch {
            ok = false
          }
          if (ok) discardIfMatch(questionId, content)
          return [questionId, ok]
        }
      )
    )
  }

  async function runRetryCycle(
    attempt: (questionId: string, content: T) => Promise<boolean>
  ) {
    const snapshot = Array.from(record.entries())
    // The loop only reschedules once this cycle settles, so an attempt that
    // never settles (a fetch stuck on a half-open connection has no timeout
    // of its own) would end retries for the rest of the exam. Give up on it
    // instead; the request itself carries on in the background, exactly as
    // it did under the old setInterval loop.
    const bounded = (questionId: string, content: T) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        attempt(questionId, content),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), attemptTimeoutMs)
        }),
      ]).finally(() => clearTimeout(timer))
    }
    const results = await runAttempts(snapshot, bounded)
    const allSucceeded = results.every(([, ok]) => ok)
    if (allSucceeded) {
      failedCycles = 0
    } else {
      failedCycles += 1
      if (maxRetries > 0 && failedCycles >= maxRetries) stopRetryLoop()
    }
  }

  return {
    enqueue(questionId: string, content: T) {
      record.set(questionId, content)
      schedulePersist(questionId)
    },
    entries() {
      return Array.from(record.entries())
    },
    get(questionId: string) {
      return record.get(questionId)
    },
    discardIfMatch,
    discard(questionId: string) {
      if (record.delete(questionId)) persistNow()
    },
    persistNow,
    clearAll() {
      record.clear()
      persistNow()
      // After a confirmed submission no tab of this session ever replays
      // again, so remove EVERY record of the session — this tab's, other
      // tabs' pre-takeover records, detached post-takeover edits and their
      // markers — instead of leaving unsaved answers in localStorage.
      try {
        const { storage } = options
        if (storage.key !== undefined) {
          const doomed: string[] = []
          for (let i = 0; i < (storage.length ?? 0); i++) {
            const k = storage.key(i)
            if (
              k !== null &&
              (k === sessionKey || k.startsWith(`${sessionKey}:`))
            )
              doomed.push(k)
          }
          for (const k of doomed) storage.removeItem(k)
        } else {
          storage.removeItem(keyOf())
          storage.removeItem(replacedKeyOf())
        }
      } catch {
        // Nothing to clear.
      }
    },
    replay(load: (pending: Array<[string, T]>) => void) {
      hydrate()
      load(Array.from(record.entries()))
    },
    markReplaced() {
      replaced = true
      try {
        options.storage.setItem(replacedKeyOf(), "1")
      } catch {
        // The in-memory flag still detaches this tab's writes.
      }
    },
    clearReplaced() {
      replaced = false
      try {
        options.storage.removeItem(replacedKeyOf())
      } catch {
        // Nothing to clear.
      }
    },
    startRetryLoop(
      attempt: (questionId: string, content: T) => Promise<boolean>
    ) {
      if (retryRunning) return stopRetryLoop
      retryRunning = true
      failedCycles = 0
      // Self-rescheduling rather than setInterval: the next attempt is timed
      // from the end of the previous one, so a slow or failing server spaces
      // retries out instead of stacking them, and each period picks a fresh
      // jitter (see RETRY_JITTER).
      const schedule = () => {
        const spread = retryIntervalMs * RETRY_JITTER
        retryTimer = setTimeout(
          async () => {
            await runRetryCycle(attempt)
            if (retryRunning) schedule()
          },
          retryIntervalMs - spread + random() * 2 * spread
        )
      }
      schedule()
      return stopRetryLoop
    },
    stopRetryLoop,
    async flush(attempt: (questionId: string, content: T) => Promise<boolean>) {
      const snapshot = Array.from(record.entries())
      return runAttempts(snapshot, attempt)
    },
    destroy() {
      stopRetryLoop()
      for (const timer of debounceTimers.values()) clearTimeout(timer)
      debounceTimers.clear()
    },
  }
}

/** Keep pending answers in memory even if browser persistence is denied. */
export function createLocalAnswerBuffer<T = unknown>(
  sessionId: string,
  // Lazy: the tab identity is browser-only module state, must not be minted
  // during a server render, and can change once before the first edit.
  tabId?: () => string
): AnswerBuffer<T> {
  const storage = getLocalStorage() ?? {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
  return createAnswerBuffer<T>({ sessionId, storage, tabId })
}
