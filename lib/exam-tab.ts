/**
 * Identity of this document's exam tab, sent with every session request and
 * the exam socket (lib/exam-device.ts).
 *
 * The identity lives in sessionStorage, which survives reloads and full
 * navigations within the tab. Browsers also copy sessionStorage into a
 * duplicated tab or a window.open child, so a stored identity can be shared
 * by two live tabs. ensureExclusiveExamTabId() resolves that with a Web Lock
 * held for the document's lifetime: a tab that finds its identity held by
 * another live tab mints a new one. Navigation type alone cannot tell the
 * two apart: a duplicate that is reloaded before it opens the exam reports
 * "reload" too.
 *
 * Without Web Locks the stored identity is reused only when Navigation
 * Timing reports a reload, as the narrower fallback.
 */
const STORAGE_KEY = "openexam.examTabId"
const LOCK_PREFIX = "openexam-exam-tab:"
// How long a new document waits for its stored identity's lock. A reload's
// previous document releases it as it unloads; a live duplicate never does.
const LOCK_WAIT_MS = 1_000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let tabId: string | null = null
let heldId: string | null = null

function locks(): LockManager | null {
  try {
    return typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks
      : null
  } catch {
    return null
  }
}

function storeTabId(id: string): void {
  tabId = id
  try {
    sessionStorage.setItem(STORAGE_KEY, id)
  } catch {
    // The in-memory identity still works for this document.
  }
}

export function getExamTabId(): string {
  if (tabId) return tabId

  let stored: string | null = null
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as
      PerformanceNavigationTiming | undefined
    if (locks() !== null || navigation?.type === "reload") {
      stored = sessionStorage.getItem(STORAGE_KEY)
    }
  } catch {
    // Storage may be unavailable in a locked-down browser.
  }

  storeTabId(stored && UUID_PATTERN.test(stored) ? stored : crypto.randomUUID())
  return tabId as string
}

/** Resolves once the lock is held; the lock is kept until the page unloads. */
function holdLock(
  manager: LockManager,
  id: string,
  options: LockOptions
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    manager
      .request(`${LOCK_PREFIX}${id}`, options, (lock) => {
        resolve(lock !== null)
        // Never settles: the lock is released when the document goes away.
        return lock === null ? undefined : new Promise<never>(() => {})
      })
      .catch(reject)
  })
}

/**
 * Makes sure no other live tab uses this tab's identity, minting a new one if
 * one does. Call before claiming the session; the result is also what
 * getExamTabId() returns from then on.
 */
export async function ensureExclusiveExamTabId(
  waitMs = LOCK_WAIT_MS
): Promise<string> {
  const id = getExamTabId()
  const manager = locks()
  if (manager === null || heldId === id) return id
  try {
    if (await holdLock(manager, id, { signal: AbortSignal.timeout(waitMs) })) {
      heldId = id
      return id
    }
  } catch {
    // Timed out: another live tab holds this identity.
  }
  // A fresh UUID: its lock is free unless two tabs mint the same UUID.
  const fresh = crypto.randomUUID()
  storeTabId(fresh)
  try {
    if (await holdLock(manager, fresh, { ifAvailable: true })) heldId = fresh
  } catch {
    // Unheld, the identity still works; a later duplicate just cannot see it.
  }
  return fresh
}
