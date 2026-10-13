/**
 * Web Storage accessors that never throw.
 *
 * Two environments break a bare `localStorage` / `sessionStorage` reference:
 *
 * - Server rendering. Next.js renders "use client" components on the server,
 *   where neither global exists, so any read reached during render throws.
 * - A browser that denies site data. Merely *resolving* the global raises
 *   SecurityError under Safari's private mode and locked-down managed
 *   profiles — a `typeof window` guard does not help, because window is
 *   present and it is the storage property that throws.
 *
 * Everything built on these is a convenience layered over state the server
 * already holds: theme pinning, in-exam text size, the crash-safe answer
 * buffer, the submit idempotency key. Degrading each to a no-op is always
 * preferable to the alternative, which in this app means a student who
 * cannot open or submit an exam because their browser blocks storage.
 *
 * Callers that need to know whether anything was actually stored get it from
 * the boolean returns rather than from an exception.
 */

function local(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null
    return localStorage
  } catch {
    return null
  }
}

function session(): Storage | null {
  try {
    if (typeof sessionStorage === "undefined") return null
    return sessionStorage
  } catch {
    return null
  }
}

/** The real localStorage, or null when it cannot be used. */
export function getLocalStorage(): Storage | null {
  return local()
}

export function readLocal(key: string): string | null {
  try {
    return local()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Returns whether the value was actually written. */
export function writeLocal(key: string, value: string): boolean {
  try {
    const store = local()
    if (store === null) return false
    store.setItem(key, value)
    return true
  } catch {
    // Denied, or quota exhausted.
    return false
  }
}

export function removeLocal(key: string): void {
  try {
    local()?.removeItem(key)
  } catch {
    // Nothing to do — the entry is unreachable either way.
  }
}

export function readSession(key: string): string | null {
  try {
    return session()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** Returns whether the value was actually written. */
export function writeSession(key: string, value: string): boolean {
  try {
    const store = session()
    if (store === null) return false
    store.setItem(key, value)
    return true
  } catch {
    return false
  }
}
