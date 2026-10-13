import { type NextRequest, NextResponse } from "next/server"
import { isOriginAllowed } from "@/lib/csrf"
import { forbidden, unauthorized } from "@/lib/api-response"
import { SESSION_COOKIE_NAMES } from "@/lib/storage-keys"

export const PUBLIC_ROUTES = [
  "/",
  "/login",
  "/register",
  "/register-teacher",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  // Datenschutzerklärung and Impressum: linked from registration, so they
  // must be readable before an account exists.
  "/datenschutz",
  "/impressum",
  "/api/auth",
  // Teacher self-registration: one-shot captcha + access-code check, no
  // session exists yet (production sign-up never issues one).
  "/api/teacher/register",
  // Cap CAPTCHA proxy — the widget fetches it before any auth exists.
  "/cap-api",
  // Liveness probe for the Docker HEALTHCHECK — must respond without a session.
  "/api/health",
  // Prometheus scrape target — reachable only over the Docker internal
  // network; nginx denies this path publicly (app/api/metrics/route.ts).
  "/api/metrics",
  // Readiness probe for monitoring (Postgres/Redis/S3). Returns only booleans.
  "/api/ready",
]

// Session cookie name used by Better Auth. In production (secure cookies) the
// cookie is emitted with the `__Secure-` prefix, so both variants are checked.
function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => req.cookies.has(name))
}

const UNSAFE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

// Origin check for every mutating /api/* request. A missing Origin is
// rejected; non-browser clients (load tests, Playwright) set it explicitly.
function hasValidOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return false
  // Same allowlist as lib/csrf.ts verifyOrigin.
  return isOriginAllowed(origin)
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (
    pathname.startsWith("/api/") &&
    UNSAFE_METHODS.includes(req.method) &&
    !hasValidOrigin(req)
  ) {
    return forbidden("Ungültiger Origin")
  }

  if (
    PUBLIC_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))
  ) {
    return NextResponse.next()
  }

  // SEB requests these without a cookie. Both routes do their own auth
  // (launch token / one-time token); this only lets the request reach them.
  if (
    /^\/api\/exams\/[^/]+\/seb-config$/.test(pathname) ||
    /^\/exam\/[^/]+\/seb-enter$/.test(pathname)
  ) {
    return NextResponse.next()
  }

  // Edge Runtime can't run Prisma — check cookie presence only.
  // Full session validation and role enforcement happen in each page route.
  if (!hasSessionCookie(req)) {
    // API routes answer 401 JSON; pages redirect to /login.
    if (pathname.startsWith("/api/")) {
      return unauthorized()
    }
    // Return to the requested page after login. `next` is validated in
    // lib/safe-redirect.ts.
    const loginUrl = new URL("/login", req.url)
    loginUrl.searchParams.set("next", pathname + req.nextUrl.search)
    return NextResponse.redirect(loginUrl)
  }

  // SEB enforcement (UA/header check + SHA-256 config key validation) runs in
  // the exam page route (Node.js runtime), which is the only place that can
  // check the exam's actual `sebRequired` flag — Edge Runtime can't run Prisma.

  return NextResponse.next()
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
