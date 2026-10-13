import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"

export const dynamic = "force-dynamic"

// How long to wait for the auth context to settle before deciding it is simply
// still initializing. Comfortably under the HEALTHCHECK's own 5s timeout.
const AUTH_SETTLE_TIMEOUT_MS = 1_500

// Consecutive confirmed-rejected observations before the process gives up and
// exits. Matches the HEALTHCHECK's `retries: 3` at `interval: 30s`, so the
// container is already being reported unhealthy by the time this fires.
const EXIT_AFTER_CONSECUTIVE_FAILURES = 3

// Grace before exiting so the 503 is written before the process ends.
const EXIT_GRACE_MS = 250

let consecutiveAuthFailures = 0

/**
 * Liveness probe for the Docker HEALTHCHECK.
 *
 * Shared dependencies (Postgres, Redis, S3) are deliberately not checked here;
 * those belong in /api/ready, so a shared outage never restarts every replica.
 *
 * The auth context is the exception. better-auth builds it once per process,
 * and if it rejects (e.g. a failed OIDC discovery fetch) it stays rejected and
 * every request returns 500. That fault is process-local and permanent, so
 * after EXIT_AFTER_CONSECUTIVE_FAILURES confirmations the process exits and
 * the restart policy (which only reacts to exits) replaces it.
 */
export async function GET() {
  // Only a rejected context is unhealthy; a pending one is still starting up.
  const authState = await Promise.race([
    auth.$context.then(
      () => "ok" as const,
      () => "failed" as const
    ),
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), AUTH_SETTLE_TIMEOUT_MS)
    ),
  ])

  if (authState === "failed") {
    consecutiveAuthFailures += 1

    if (consecutiveAuthFailures >= EXIT_AFTER_CONSECUTIVE_FAILURES) {
      // console.error, not pino: pino's worker transport may not flush
      // before process.exit().
      console.error(
        `[health] auth context permanently rejected (${consecutiveAuthFailures} consecutive checks) — exiting so the restart policy replaces this process`
      )
      setTimeout(() => process.exit(1), EXIT_GRACE_MS)
    }

    return NextResponse.json(
      { ok: false, checks: { auth: false } },
      { status: 503 }
    )
  }

  // Only a settled-OK context resets the counter; "pending" leaves it.
  if (authState === "ok") consecutiveAuthFailures = 0

  return NextResponse.json({ ok: true })
}
