import type { ApiErrorCode } from "@/lib/api-response"

/**
 * The client half of the API error contract.
 *
 * `lib/api-response.ts` fixes the envelope every route replies with
 * (`{ error: { code, message } }`); this module is the single place that
 * *reads* it. Before it existed, ~60 call sites across the component tree
 * each open-coded the same four steps — fetch, parse, `if (!res.ok)` pull
 * `error.message` out by hand, toast — and they had already drifted three
 * ways: some used `data.error?.message`, some the safer
 * `data?.error?.message` with a `.catch(() => null)` on the parse, and some
 * ignored the body entirely and hardcoded a German string that could not
 * reflect what the server actually refused.
 *
 * The drift is the reason to centralise, not the duplication: a route that
 * starts answering 409 instead of 422, or that adds a `Retry-After`, should
 * be adjustable in one file rather than chased through the tree.
 *
 * Deliberately *not* handled here, mirroring the boundary `lib/api-auth.ts`
 * draws on the server side: nothing about authentication, ownership or
 * resource semantics. This transports a request and normalises the reply.
 *
 * Note the asymmetry with the `lib/*-query.ts` modules, which are
 * server-only Prisma readers for RSC pages. This module is the client-side
 * *write* path and shares no code with them.
 */

/**
 * A `fetch`-shaped transport. `lib/seb-client.ts`'s `sebFetch` matches this
 * signature exactly (it only injects SEB attestation headers), so exam-taking
 * call sites pass it here instead of this module importing it — which keeps
 * `api-mutate` free of the SEB handshake and testable on its own.
 */
export type Fetcher = typeof fetch

/**
 * Errors are values here, never exceptions — the same rule the `lib/*-query`
 * modules follow. Callers branch on `ok` and always get a `message` fit to
 * show a user.
 *
 * `status` and `code` are both carried because call sites legitimately need
 * either: the exam submit path treats HTTP 409 as success (a double submit is
 * not a failure), and `code` is the stable half of the contract for anything
 * that wants to branch without matching German prose.
 *
 * `payload` on the failure side is the parsed body as it arrived. Almost no
 * caller wants it — `message` is the answer — but the question-bank import
 * needs it: a rejected batch still lists the per-item failures that *did*
 * land, and dropping them would turn a partial success into a total one.
 *
 * `data` is typed as `T` rather than `T | null` because a 2xx that is *not*
 * parseable JSON is reported as a failure (see below). An empty response is
 * accepted only for a status that explicitly promises no content (204 or
 * 205), whose callers must not read `data`. Passing a `T` to
 * {@link apiMutate} is therefore an assertion that the route answers with a
 * JSON value.
 */
export type MutateResult<T> =
  | { ok: true; data: T; status: number }
  | {
      ok: false
      data: null
      payload: unknown
      code: ApiErrorCode | null
      message: string
      status: number
    }

export interface MutateOptions {
  /** Defaults to POST — the overwhelmingly common case for a mutation. */
  method?: "POST" | "PUT" | "PATCH" | "DELETE"
  /**
   * `FormData` is passed through untouched so the browser can set the
   * multipart boundary; anything else is JSON-stringified and gets the JSON
   * content type. Omit for verbs that carry no body (DELETE, most POSTs).
   */
  body?: unknown
  /** Defaults to the global `fetch`. Pass `sebFetch` on exam-taking paths. */
  fetcher?: Fetcher
  /** German text shown when the reply carries no usable `error.message`. */
  fallbackError: string
  /**
   * German text for a transport failure (offline, DNS, TLS), where there is
   * no reply to read at all. Several call sites word this differently from
   * `fallbackError` ("Verbindungsfehler…" vs "Fehler beim Speichern"), so it
   * is separate; it falls back to `fallbackError` when not given.
   */
  networkError?: string
}

/** Status reported when the request never reached the server. */
const NO_RESPONSE_STATUS = 0

/**
 * Perform a mutating API call and normalise the reply.
 *
 * Never rejects: a transport failure resolves to `ok: false` with
 * `status: 0` and `code: null`, so callers need no `try/catch`.
 */
export async function apiMutate<T = unknown>(
  url: string,
  options: MutateOptions
): Promise<MutateResult<T>> {
  const {
    method = "POST",
    body,
    fetcher,
    fallbackError,
    networkError,
  } = options

  // `fetch` must not be passed around unbound — a bare reference called with
  // no receiver throws "Illegal invocation" in browsers.
  const send: Fetcher = fetcher ?? ((input, init) => fetch(input, init))

  // A mutation the server never confirmed: a transport failure, or a reply
  // that is not this API answering. Both carry no usable error envelope, so
  // the caller gets the transport message and a `null` code.
  const unconfirmed = (status: number): MutateResult<T> => ({
    ok: false,
    data: null,
    payload: null,
    code: null,
    message: networkError ?? fallbackError,
    status,
  })

  const init: RequestInit = { method, headers: {} }
  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body
    } else {
      init.body = JSON.stringify(body)
      init.headers = { "Content-Type": "application/json" }
    }
  }

  let res: Response
  try {
    res = await send(url, init)
  } catch {
    return unconfirmed(NO_RESPONSE_STATUS)
  }

  // Read as text first, then parse: a status that explicitly carries no body
  // (204 or 205) and one whose promised JSON is absent or malformed are
  // different things. Only the first is a completed mutation. Reading the
  // body may not throw — it is best-effort on the failure side.
  let raw = ""
  let readFailed = false
  try {
    raw = await res.text()
  } catch {
    // The connection died mid-body. We do not know what the server said, so
    // this is not an empty reply — it is an unreadable one.
    readFailed = true
  }
  const hasBody = raw.trim() !== ""
  let parsedBody = false
  let payload: unknown = null
  if (hasBody) {
    try {
      payload = JSON.parse(raw)
      parsedBody = true
    } catch {
      payload = null
    }
  }

  if (res.ok) {
    // A 2xx whose body is present but unparseable — or unreadable — is not
    // this API answering, so it must not be reported as a completed mutation:
    // the exam submit path clears the student's locally buffered answers and
    // navigates away on success, and the question-bank import advances its
    // batch loop. Both are unrecoverable if a proxy's 200 is mistaken for a
    // real reply. An empty body stays successful only when the status itself
    // promises no content (204 or 205).
    const emptyBodyAllowed = res.status === 204 || res.status === 205
    if (
      readFailed ||
      (hasBody && !parsedBody) ||
      (!hasBody && !emptyBodyAllowed)
    ) {
      return unconfirmed(res.status)
    }
    return { ok: true, data: payload as T, status: res.status }
  }

  const envelope = payload as {
    error?: { code?: string; message?: string }
  } | null

  return {
    ok: false,
    data: null,
    payload,
    code: (envelope?.error?.code as ApiErrorCode | undefined) ?? null,
    message: envelope?.error?.message ?? fallbackError,
    status: res.status,
  }
}
