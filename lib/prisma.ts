import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/generated/prisma/client"

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient }

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
  const max = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : undefined
  const adapter = new PrismaPg({ connectionString, max })
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
