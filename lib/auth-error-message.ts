/**
 * German message for a Better Auth client error.
 *
 * Better Auth's own messages are English ("Invalid email or password", "Too
 * many requests. Please try again later."), and the auth forms showed them
 * verbatim in the German UI. Only the app's own error codes (lib/auth.ts)
 * carry German messages, so the server's text is shown for those alone;
 * known Better Auth codes and rate limiting are translated, and anything
 * else (plugin errors included) falls back to the form's German message.
 */

/** Codes thrown by lib/auth.ts, whose messages are already German. */
const APP_CODES = new Set([
  "PRIVACY_NOT_ACCEPTED",
  "SCHOOL_DOMAIN_REQUIRED",
  // Per-account throttle (HTTP 429); its message names the wait time.
  "ACCOUNT_RATE_LIMITED",
  // Display-name check on sign-up and profile updates (lib/display-name.ts).
  "INVALID_NAME",
])

const MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "E-Mail-Adresse oder Passwort ist falsch.",
  INVALID_PASSWORD: "Das Passwort ist falsch.",
  INVALID_EMAIL: "Die E-Mail-Adresse ist ungültig.",
  USER_NOT_FOUND: "E-Mail-Adresse oder Passwort ist falsch.",
  EMAIL_NOT_VERIFIED: "Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse.",
  PASSWORD_TOO_SHORT: "Das Passwort ist zu kurz.",
  PASSWORD_TOO_LONG: "Das Passwort ist zu lang.",
  USER_ALREADY_EXISTS: "Mit dieser E-Mail-Adresse besteht bereits ein Konto.",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "Mit dieser E-Mail-Adresse besteht bereits ein Konto.",
  INVALID_TOKEN: "Der Link ist ungültig oder abgelaufen.",
  TOKEN_EXPIRED: "Der Link ist abgelaufen.",
  SESSION_EXPIRED:
    "Ihre Sitzung ist abgelaufen. Bitte melden Sie sich erneut an.",
  EMAIL_ALREADY_VERIFIED: "Diese E-Mail-Adresse ist bereits bestätigt.",
}

const TOO_MANY_REQUESTS =
  "Zu viele Versuche. Bitte warten Sie einen Moment und versuchen Sie es erneut."

export function authErrorMessage(
  error:
    { code?: string; message?: string; status?: number } | null | undefined,
  fallback: string
): string {
  if (!error) return fallback
  if (error.code && APP_CODES.has(error.code) && error.message) {
    return error.message
  }
  if (error.status === 429) return TOO_MANY_REQUESTS
  return (error.code && MESSAGES[error.code]) || fallback
}
