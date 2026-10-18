import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/generated/prisma/client"

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

// How long an interactive `$transaction` may wait for a pool connection
// before Prisma gives up with P2028 ("Unable to start a transaction in the
// given time"). Prisma's default is 2 s, which is shorter than the pool queue
// gets in an exam-start burst: on 2026-10-14, 2400 students joining 96 exams
// in the same second turned 115 joins into HTTP 500s with exactly that
// error. A student would rather wait a few seconds for their join, answer
// save or submit than get an error page, and the queue drains in seconds, so
// waiting longer only turns would-be 500s into slower successes. Ordinary
// queries already wait in the pool without any cap. The transaction's own
// `timeout` (5 s, measured from when it actually starts) is unchanged.
export const DEFAULT_TX_MAX_WAIT_MS = 10_000

export function transactionMaxWaitMs(
  raw: string | undefined = process.env.DB_TX_MAX_WAIT_MS
): number {
  const parsed = Number(raw)
  return raw && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TX_MAX_WAIT_MS
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL must be set")
  // max is a pg.Pool option, not a DATABASE_URL query param: @prisma/adapter-pg
  // wraps node-postgres directly, bypassing Prisma's classic query engine, so
  // a `?connection_limit=` in the URL (that engine's mechanism) is silently
  // ignored here. Left unset, node-postgres pools are unbounded, capped only
  // by the OS — a real risk once multiple replicas share one Postgres
  // instance. DB_POOL_MAX is set in docker-compose.prod.yml; see the comment
  // there for the number.
  const parsedMax = Number(process.env.DB_POOL_MAX)
  const max =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined
  const adapter = new PrismaPg({ connectionString, max })
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: transactionMaxWaitMs() },
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
