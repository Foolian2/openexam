import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { redis } from "@/lib/redis"
import { logError } from "@/lib/logger"

export const dynamic = "force-dynamic"

const CHECK_TIMEOUT_MS = 2_000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("timed out")), ms)
    ),
  ])
}

// Public, unauthenticated endpoint: a check result is either true or false
// out the wire. The underlying error (which carries internal hostnames and
// endpoints) is logged server-side, never returned to the caller.
async function check(
  name: string,
  fn: () => Promise<unknown>
): Promise<boolean> {
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS)
    return true
  } catch (err) {
    logError(`readiness: ${name} check failed`, {
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Deep readiness check — Postgres and Redis reachability, each
 * bounded by a short timeout so a hung dependency can't hang the probe.
 *
 * Deliberately separate from /api/health, whose own comment says not to add
 * dependency checks there: a DB/Redis blip must not restart web containers
 * mid-exam via a liveness probe. This route is a monitoring/dashboard
 * target, not wired into the Docker HEALTHCHECK.
 */
export async function GET() {
  // No storage check: uploaded files live in Postgres (AnswerFile), so the
  // database check covers them.
  const [database, redisOk] = await Promise.all([
    check("database", () => prisma.$queryRaw`SELECT 1`),
    check("redis", () => redis.ping()),
  ])

  const ok = database && redisOk

  return NextResponse.json(
    { ok, checks: { database, redis: redisOk } },
    { status: ok ? 200 : 503 }
  )
}
