import { NextResponse } from "next/server"

/**
 * The error envelope every API route replies with:
 *
 *     { error: { code, message } }
 *
 * Centralised so the shape can't drift route by route. The client parses
 * `code` (never the message) to decide what to do, and the German `message`
 * is what the user actually sees — so both halves are part of the contract
 * and neither may be reworded casually.
 *
 * Note on 404 vs 403: routes that fail an ownership check answer 404, not
 * 403, so a caller can't use the status as an oracle for whether an id
 * exists. Pass the resource's own "not found" text to {@link notFound} for
 * both the missing case and the not-yours case — identical replies are the
 * point.
 */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "UNKNOWN_ERROR"
  // Domain codes the client branches on for a specific message or flow.
  | "NOT_STARTED"
  | "EXAM_ENDED"
  | "EMAIL_TAKEN"
  | "CAPTCHA_INVALID"

export function apiError(
  code: ApiErrorCode,
  message: string,
  status: number,
  init?: ResponseInit
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { ...init, status })
}

/** 401 — no (or no longer valid) session cookie. */
export function unauthorized(message = "Nicht angemeldet"): NextResponse {
  return apiError("UNAUTHORIZED", message, 401)
}

/** 403 — authenticated, but the role or origin isn't permitted. */
export function forbidden(message = "Keine Berechtigung"): NextResponse {
  return apiError("FORBIDDEN", message, 403)
}

/**
 * 404 — missing *or* not the caller's. Deliberately indistinguishable; see
 * the note above.
 */
export function notFound(message: string): NextResponse {
  return apiError("NOT_FOUND", message, 404)
}

/** 422 — well-formed request whose contents failed validation. */
export function validationError(message: string): NextResponse {
  return apiError("VALIDATION_ERROR", message, 422)
}

/** 409 — the resource's current state forbids the transition. */
export function conflict(message: string): NextResponse {
  return apiError("CONFLICT", message, 409)
}

/**
 * 429 — over budget. Always carries Retry-After: without it a client that
 * backs off blindly can synchronise with every other client and re-hammer
 * the limiter in lockstep.
 */
export function rateLimited(
  retryAfterSeconds: number,
  message = "Zu viele Anfragen. Bitte später erneut versuchen."
): NextResponse {
  return apiError("RATE_LIMITED", message, 429, {
    headers: { "Retry-After": String(retryAfterSeconds) },
  })
}

/**
 * Thrown from inside a `prisma.$transaction` callback to abort it with a
 * specific reply: a transaction only rolls back on a throw, so a route that
 * discovers a 404/409 mid-transaction throws this, catches it around the
 * transaction, and answers with {@link ApiError.toResponse}.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = "ApiError"
  }

  toResponse(): NextResponse {
    return apiError(this.code, this.message, this.status)
  }
}
