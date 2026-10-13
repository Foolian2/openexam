"use client"

import { getExamTabId } from "@/lib/exam-tab"

/**
 * Client-side bridge to the SEB JS API
 * (https://safeexambrowser.org/developer/seb-javascript-api.html).
 * `SafeExamBrowser.security.updateKeys()` recomputes
 * `SafeExamBrowser.security.configKey` for the current page URL — exactly
 * T = sha256(pageURL + ConfigKey), the same token the native
 * X-SafeExamBrowser-ConfigKeyHash header carries on Windows. This lets a
 * single token work as both a header (REST) and the WS handshake's first
 * message, on every SEB platform including macOS/iOS where WKWebView
 * cannot send custom headers at all.
 */

declare global {
  interface Window {
    SafeExamBrowser?: {
      security: {
        configKey?: string
        browserExamKey?: string
        // SEB invokes this callback with NO arguments, and does so by *name*
        // (see getSebKey), not by reference. The fresh key is read off
        // `security.configKey`, which SEB sets before calling back.
        updateKeys: (callback: () => void) => void
      }
    }
  }
}

const UPDATE_KEYS_TIMEOUT_MS = 3_000

export interface SebSecurityKeys {
  configKey: string | null
  browserExamKey: string | null
}

let cachedKeysPromise: Promise<SebSecurityKeys> | null = null

/**
 * Runs SEB's `updateKeys()` handshake once and resolves both security values
 * for the current page URL, or nulls outside SEB or on timeout. A successful
 * handshake is memoized for the page's lifetime.
 *
 * The named global callback is required: SEB's macOS bridge calls it by
 * evaluating `<name>();` in global scope, so it must live on `window` under a
 * matching `.name` (an anonymous arrow has none).
 */
function resolveSebKeys(): Promise<SebSecurityKeys> {
  if (cachedKeysPromise) return cachedKeysPromise

  const attempt: Promise<SebSecurityKeys> = new Promise((resolve) => {
    const seb =
      typeof window !== "undefined" ? window.SafeExamBrowser : undefined
    if (!seb) {
      resolve({ configKey: null, browserExamKey: null })
      return
    }

    const globalObj = window as unknown as Record<string, unknown>
    const cbName = `__sebUpdateKeysCb_${Date.now()}_${Math.floor(Math.random() * 1e9)}`

    let settled = false
    const finish = (value: SebSecurityKeys) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      // Leave a no-op behind: native may still call it after a timeout.
      globalObj[cbName] = () => {}
      resolve(value)
    }

    const timeout = setTimeout(
      () => finish({ configKey: null, browserExamKey: null }),
      UPDATE_KEYS_TIMEOUT_MS
    )

    // Computed method name gives the function `.name === cbName`.
    const callback = {
      [cbName]() {
        const security = window.SafeExamBrowser?.security
        finish({
          configKey: security?.configKey || null,
          browserExamKey: security?.browserExamKey || null,
        })
      },
    }[cbName]
    globalObj[cbName] = callback

    try {
      seb.security.updateKeys(callback)
    } catch {
      finish({ configKey: null, browserExamKey: null })
    }
  })

  // Only cache a real handshake; a cached timeout would deny the student for
  // the rest of the page's lifetime.
  cachedKeysPromise = attempt
  void attempt.then((keys) => {
    if (
      !keys.configKey &&
      !keys.browserExamKey &&
      cachedKeysPromise === attempt
    ) {
      cachedKeysPromise = null
    }
  })

  return cachedKeysPromise
}

/** Resolves the current page's Config Key token, or null if not inside SEB. */
export async function getSebKey(): Promise<string | null> {
  return (await resolveSebKeys()).configKey
}

/**
 * Resolves the current page's Browser Exam Key RequestHash
 * (`SafeExamBrowser.security.browserExamKey`), or null if not inside SEB.
 */
export async function getSebRequestHash(): Promise<string | null> {
  return (await resolveSebKeys()).browserExamKey
}

/**
 * Our own header for the Browser Exam Key RequestHash. Not
 * `x-safeexambrowser-requesthash`, which Windows SEB rewrites per URL.
 *
 * Keep in sync with SEB_BEK_HEADER in lib/seb-guard.ts.
 */
const SEB_BEK_HEADER = "x-openexam-seb-requesthash"

/**
 * `fetch` wrapper that attaches the SEB Config Key token and, when available,
 * the Browser Exam Key RequestHash.
 */
export async function sebFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const { configKey, browserExamKey } = await resolveSebKeys()
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined
  )
  new Headers(init.headers).forEach((value, name) => headers.set(name, value))
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin
  )
  if (
    url.origin === window.location.origin &&
    (url.pathname === "/api/sessions" ||
      url.pathname.startsWith("/api/sessions/"))
  ) {
    headers.set("x-openexam-device-id", getExamTabId())
  }
  if (configKey) headers.set("x-safeexambrowser-configkeyhash", configKey)
  if (browserExamKey) headers.set(SEB_BEK_HEADER, browserExamKey)
  return fetch(input, { ...init, headers })
}
