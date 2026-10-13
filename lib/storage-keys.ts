// Cookie and Web Storage names the app writes in the browser. Kept in one
// plain (non-"use client") module so the cookie table on /datenschutz
// (lib/legal/storage-inventory.ts) imports the same strings the code uses —
// a renamed key can't silently leave the privacy policy out of date.

// Better Auth's session cookie. In production (secure cookies) it carries
// the `__Secure-` prefix, so both variants exist.
export const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const

// Session lifetime in seconds (lib/auth.ts session.expiresIn).
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

// shadcn sidebar open/closed state (components/ui/sidebar.tsx).
export const SIDEBAR_COOKIE_NAME = "sidebar_state"
export const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7

// Crash-safe answer buffer, suffixed with `:<sessionId>` (lib/answer-buffer.ts).
export const ANSWER_BUFFER_KEY_PREFIX = "openexam:pending"

// Idempotency key for exam submission, suffixed with `:<sessionId>`
// (components/exam-taking/exam-runner.tsx).
export const SUBMIT_KEY_PREFIX = "openexam:submitkey"

// Last question type chosen in the editor (components/questions/question-builder.tsx).
export const LAST_QUESTION_TYPE_KEY = "nextopen.last-question-type"

// next-themes' default storage key (components/theme-provider.tsx).
export const THEME_STORAGE_KEY = "theme"
