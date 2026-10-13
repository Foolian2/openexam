// Auth headers, built from pre-signed session cookies rather than real
// sign-up/sign-in HTTP calls.
//
// Two independent reasons rule out the real HTTP flow for k6 VUs:
//   - Better Auth's sign-in/sign-up rate limiter (5/60s, lib/auth.ts) keys
//     on the caller's *IP*, not the account — every VU authenticating
//     from the same load-generator host shares one IP-scoped budget, so
//     even "each VU signs in once" throttles past ~5 VUs.
//   - A session created via the real sign-in flow lives only in Redis
//     (Better Auth's secondaryStorage cache) and is never written to
//     Postgres, which is all ws-backend ever checks
//     (ws-backend/internal/store/store.go's LookupSession) — so a
//     real-signed-in cookie can drive REST calls fine but always fails a
//     WS upgrade. See scripts/load-seed.ts's header comment for the full
//     story; that script mints sessions directly into both stores so a
//     single cookie authenticates against both surfaces.
import { ORIGIN_HEADER, SESSION_COOKIE_NAME } from "../config.js"

// Wraps one seed-users.json / seed-teachers.json entry's pre-signed
// cookie in a headers object. Used both in setup() (e.g. pre-joining
// sessions for many seed users up front) and cached per-VU below.
export function authHeadersForUser(user) {
  return { Cookie: `${SESSION_COOKIE_NAME}=${user.sessionCookie}`, ...ORIGIN_HEADER }
}

let cachedHeaders = null

// Returns this VU's student auth headers, built once from a pre-signed
// session cookie assigned deterministically by VU id (see
// scripts/load-seed.ts). No network call — nothing to rate-limit.
export function getStudentAuthHeaders(seedUsers) {
  if (cachedHeaders) return cachedHeaders

  const user = seedUsers[(__VU - 1) % seedUsers.length]
  cachedHeaders = authHeadersForUser(user)
  return cachedHeaders
}
