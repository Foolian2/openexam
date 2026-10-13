/**
 * better-auth endpoints that must not be reachable over HTTP
 * (`/api/auth/[...all]`). Server code still calls them as `auth.api.*`:
 * better-auth checks `disabledPaths` only in its HTTP router.
 *
 * The one-time-token pair is the SEB sign-in handoff. Both ends run
 * server-side — `launch-seb/page.tsx` generates, `seb-enter/route.ts`
 * redeems after its SEB User-Agent and cookieless checks. Left on HTTP,
 * `POST /one-time-token/verify` lets anyone holding an OTT (from a log,
 * proxy or shoulder-surfed launch link) redeem it for the student's session
 * from any client, bypassing those checks; `disableClientRequest` only
 * guards generation.
 */
export const AUTH_DISABLED_PATHS: string[] = [
  "/one-time-token/generate",
  "/one-time-token/verify",
]
