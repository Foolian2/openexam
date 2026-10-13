// Shared config for all k6 scenarios, read from -e flags (or env vars).
//   k6 run load/scenarios/01-rest-smoke.js -e BASE_URL=http://localhost:3000
//   k6 run load/scenarios/06-classroom-ladder.js -e BASE_URL=https://exam.lan
export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "")

// In a local dev stack the two servers are reachable on separate ports
// (Next.js on 3000, ws-backend on 8080), so WS_URL has its own default. In
// front of nginx there is only one origin — /ws/ is proxied to ws-backend
// (nginx/nginx.conf) — so deriving it from BASE_URL means a remote run needs
// a single -e BASE_URL=https://host and can't end up half-pointed at
// localhost. An explicit -e WS_URL always wins.
function deriveWsUrl() {
  if (__ENV.WS_URL) return __ENV.WS_URL.replace(/\/$/, "")
  if (BASE_URL.startsWith("https://")) return BASE_URL.replace(/^https:/, "wss:")
  // Plain http BASE_URL that isn't the dev default means "everything behind
  // one origin over http" — still one origin, so derive rather than guess 8080.
  if (BASE_URL !== "http://localhost:3000") return BASE_URL.replace(/^http:/, "ws:")
  return "ws://localhost:8080"
}
export const WS_URL = deriveWsUrl()

export const TEACHER_ACCESS_CODE = __ENV.TEACHER_ACCESS_CODE || "dev-teacher-code"

// Better Auth prefixes its cookie with `__Secure-` whenever the base URL is
// https (useSecureCookies defaults to on there). Hardcoding the unprefixed
// name silently 401s against every HTTPS deployment — every request looks
// unauthenticated, which surfaces as "exam create failed: 401" in setup()
// rather than anything pointing at cookies. Derive it from the scheme, with
// an override for a deployment that has configured a custom cookiePrefix.
export const SESSION_COOKIE_NAME =
  __ENV.SESSION_COOKIE_NAME ||
  (BASE_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token")

// A benchmark VPS typically terminates TLS with a self-signed cert, which k6
// rejects by default. Scenarios spread this into their exported `options`.
// Off unless asked for, so a real-cert run still validates the chain.
export const TLS_OPTIONS = {
  insecureSkipTLSVerify: __ENV.INSECURE_SKIP_TLS_VERIFY === "true",
}

// Better Auth rejects cross-origin (or origin-less) POSTs to /api/*, and
// ws-backend's OriginPatterns check does the same on the WS upgrade — every
// unsafe request needs this header. See lib/auth.ts and ws-backend/main.go.
export const ORIGIN_HEADER = { Origin: BASE_URL }
export const JSON_HEADERS = { ...ORIGIN_HEADER, "Content-Type": "application/json" }

// Path to the file scripts/load-seed.ts writes, relative to
// load/lib/seedUsers.js (k6's open() resolves relative to the calling
// file, not the CWD or the entry scenario) — loaded via SharedArray so
// it's parsed once, not per-VU.
export const SEED_USERS_PATH = "../data/seed-users.json"
