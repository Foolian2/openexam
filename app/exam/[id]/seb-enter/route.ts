import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { isSEBUserAgent } from "@/lib/seb-user-agent"
import { takeUrl } from "@/lib/seb-urls"

type Params = { params: Promise<{ id: string }> }

/**
 * startURL of a personalized SEB config (see lib/seb-config.ts's `loginToken`).
 *
 * SEB starts with a cleared cookie jar, so this route redeems the one-time
 * token minted by app/exam/[id]/launch-seb/page.tsx and forwards the session
 * cookie Better Auth issues for it.
 *
 * Always redirects to /take. A missing, expired or rejected token falls back
 * to the normal login, since an error page inside SEB has no way out.
 *
 * The two preconditions below (SEB User-Agent, no existing session) are what
 * keep this from being usable for login CSRF. Do not remove either.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params
  // takeUrl(), not request.url: behind nginx request.url is the internal bind
  // address. It is also the exact URL the Config Key token is hashed against.
  const destination = takeUrl(id)
  const ott = request.nextUrl.searchParams.get("ott")

  if (!ott) return NextResponse.redirect(destination)

  // Precondition 1: the request must come from SEB.
  if (!isSEBUserAgent(request.headers.get("user-agent") ?? "")) {
    return NextResponse.redirect(destination)
  }

  // Each redemption attempt mints a session on success, so bound guessing
  // and replay churn per client. Keyed by exam+IP and sized for a whole class
  // starting together behind one school NAT. Over the limit the student falls
  // back to the manual login, exactly like an invalid token.
  const limit = await rateLimit(
    `seb-enter:${id}:${getClientIp(request) ?? "unknown"}`,
    200,
    60,
    "closed"
  )
  if (!limit.allowed) return NextResponse.redirect(destination)

  try {
    // Precondition 2: no existing session. Checked before redeeming so the
    // single-use token is not burned.
    const existing = await auth.api.getSession({ headers: request.headers })
    if (existing) return NextResponse.redirect(destination)

    const verified = await auth.api.verifyOneTimeToken({
      body: { token: ott },
      asResponse: true,
    })
    if (!verified.ok) return NextResponse.redirect(destination)

    const redirect = NextResponse.redirect(destination)
    // getSetCookie(): headers.get("set-cookie") folds multiple cookies into
    // one invalid comma-joined string.
    for (const cookie of verified.headers.getSetCookie()) {
      redirect.headers.append("set-cookie", cookie)
    }
    return redirect
  } catch {
    // Fall through to the manual login.
    return NextResponse.redirect(destination)
  }
}
