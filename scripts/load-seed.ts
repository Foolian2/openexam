/**
 * Provisions synthetic STUDENT and TEACHER accounts *and* ready-to-use
 * session cookies directly, for k6 load tests.
 *
 * This bypasses Better Auth's own HTTP endpoints entirely:
 *   - /api/auth/sign-up/email is rate-limited 5/60s (lib/auth.ts).
 *   - /api/auth/sign-in/email is *also* rate-limited 5/60s, and — this is
 *     the part that actually rules out calling it from k6 — the limiter
 *     keys on the caller's IP, not the account being signed into. Every k6
 *     VU signing in from the same load-generator host would share that
 *     one IP-scoped budget, so even "each VU signs in exactly once" (the
 *     obvious workaround for a per-user limit) still throttles hard the
 *     moment VU count exceeds ~5.
 *
 * So instead of ever calling sign-up/sign-in, this script mints valid
 * sessions directly and hands back already-signed cookie values.
 *
 * Each session has to be written to *two* places, because this app's two
 * servers each check a different one:
 *   - The Next.js REST API reads sessions through Better Auth, which is
 *     configured with `secondaryStorage` (Redis, lib/auth.ts) and no
 *     `session.storeSessionInDatabase` override — so with that Redis
 *     cache configured, Better Auth's internal adapter serves session
 *     reads from Redis only and never falls back to Postgres
 *     (node_modules/better-auth/dist/db/internal-adapter.mjs's
 *     `findSession`). A session that exists only in Postgres is
 *     invisible to it. This is also true of a *real* signed-in session —
 *     it's not particular to this script.
 *   - ws-backend checks Postgres directly and only
 *     (ws-backend/internal/store/store.go's `LookupSession` — a plain
 *     `SELECT ... FROM session`) and never touches Redis.
 * A cookie only authenticates against both surfaces if the session
 * exists in both stores, in the shape each side expects. This is why
 * *teachers* are minted here too, not provisioned via the real
 * sign-up/promote HTTP flow the way e2e/helpers.ts does it: a teacher
 * session created that way lives only in Redis, which is invisible to
 * ws-backend — so a teacher connecting to /ws/monitor/{examId} with a
 * real-signed-in cookie gets rejected at the WS upgrade every time. k6's
 * ws.connect() returns immediately on a rejected upgrade (it never
 * blocks waiting for a socket that was never accepted), so a scenario
 * driving that connection in a loop without accounting for this turns
 * into a tight, near-instant reconnect-attempt loop — which is exactly
 * what surfaced this while building load/scenarios/05-mixed-exam-room.js.
 *
 * The cookie value itself is the same signed-cookie format
 * ws-backend/internal/auth/auth.go verifies (mirroring better-call's
 * setSignedCookie):
 *
 *   cookie value = encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))
 *
 * k6 sends this as a raw `Cookie` header (see load/lib/auth.js).
 *
 * Idempotent for the User/Account rows: re-running with the same (or a
 * larger) --count only creates accounts that don't exist yet. Session
 * rows/cache entries are minted fresh on every run (7-day expiry,
 * harmless to accumulate for a dev/load-test database).
 *
 *   tsx --env-file-if-exists=.env scripts/load-seed.ts --count 200 --teachers 2
 *   pnpm load:seed -- --count 200 --teachers 2
 */
import crypto from "node:crypto"
import { writeFile, mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { hashPassword } from "better-auth/crypto"
import { prisma } from "@/lib/prisma"
import { redis } from "@/lib/redis"
import type { Role } from "@/generated/prisma/client"

const LOAD_TEST_PASSWORD = "k6-LoadTest-Passw0rt!"
const DEFAULT_PREFIX = "loadtest"
const DEFAULT_COUNT = 200
const DEFAULT_TEACHER_COUNT = 1
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // matches lib/auth.ts session.expiresIn
const STUDENTS_OUTPUT_PATH = path.join(process.cwd(), "load", "data", "seed-users.json")
const TEACHERS_OUTPUT_PATH = path.join(process.cwd(), "load", "data", "seed-teachers.json")

// This script mints TEACHER accounts with a publicly known password and
// live 7-day session cookies valid against both the Next.js API and
// ws-backend. Run against anything other than a local dev database, that is
// a permanent backdoor. The .env this loads is the dev one, so this only
// trips when DATABASE_URL is explicitly overridden — which is exactly when
// it must trip. Staging/prod load testing has to go through the real HTTP
// sign-up/promote flow instead.
const DB_HOST = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname
  } catch {
    return ""
  }
})()
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])
if (!LOCAL_DB_HOSTS.has(DB_HOST) && !DB_HOST.endsWith(".local")) {
  throw new Error(
    `load-seed.ts refuses to run against DATABASE_URL host "${DB_HOST}" — it mints TEACHER accounts and session cookies with a publicly known password. Point it at a local dev database (localhost/127.0.0.1/*.local).`
  )
}

function parseArgs(argv: string[]) {
  let count = DEFAULT_COUNT
  let teacherCount = DEFAULT_TEACHER_COUNT
  let prefix = DEFAULT_PREFIX

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--count") count = Number(argv[++i])
    else if (argv[i] === "--teachers") teacherCount = Number(argv[++i])
    else if (argv[i] === "--prefix") prefix = argv[++i]
  }

  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`--count must be a positive integer, got: ${count}`)
  }
  if (!Number.isInteger(teacherCount) || teacherCount <= 0) {
    throw new Error(`--teachers must be a positive integer, got: ${teacherCount}`)
  }

  return { count, teacherCount, prefix }
}

function signSessionCookie(token: string, secret: string): string {
  const signature = crypto.createHmac("sha256", secret).update(token).digest("base64")
  return encodeURIComponent(`${token}.${signature}`)
}

/** Creates (or reuses) one user + credential account + a fresh dual Postgres/Redis session. */
async function seedAccount(email: string, name: string, role: Role, passwordHash: string, secret: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, role, emailVerified: true },
  })

  const existingAccount = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  })
  const isNewAccount = !existingAccount
  if (isNewAccount) {
    await prisma.account.create({
      // better-auth keys a credential account by (providerId, accountId),
      // where the account key is the linked user's stable id.
      data: { userId: user.id, accountId: user.id, providerId: "credential", password: passwordHash },
    })
  }

  const token = crypto.randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  // Postgres — the row ws-backend's LookupSession reads directly.
  const session = await prisma.session.create({
    data: { token, userId: user.id, expiresAt, ipAddress: "", userAgent: "" },
  })

  // Redis — the cache Better Auth's internal adapter actually reads from
  // on the Next.js side, in the exact shape its own `createSession` hook
  // writes (see this file's header comment).
  const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  await redis.set(
    token,
    JSON.stringify({
      session: {
        id: session.id,
        token,
        userId: user.id,
        expiresAt: expiresAt.toISOString(),
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        ipAddress: "",
        userAgent: "",
      },
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      },
    }),
    "EX",
    ttlSeconds
  )

  return { email, sessionCookie: signSessionCookie(token, secret), isNewAccount }
}

async function main() {
  const { count, teacherCount, prefix } = parseArgs(process.argv.slice(2))
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set — run via `pnpm load:seed`, which loads .env, or export it yourself."
    )
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set — run via `pnpm load:seed`, which loads .env, or export it yourself."
    )
  }

  const passwordHash = await hashPassword(LOAD_TEST_PASSWORD)

  console.log(`Seeding ${count} student account(s) with prefix "${prefix}"...`)
  const students: { email: string; sessionCookie: string }[] = []
  let newStudents = 0
  for (let i = 0; i < count; i++) {
    const { email, sessionCookie, isNewAccount } = await seedAccount(
      `${prefix}-${i}@k6.local`,
      `Load Test Student ${i}`,
      "STUDENT",
      passwordHash,
      secret
    )
    if (isNewAccount) newStudents++
    students.push({ email, sessionCookie })
  }

  console.log(`Seeding ${teacherCount} teacher account(s) with prefix "${prefix}"...`)
  const teachers: { email: string; sessionCookie: string }[] = []
  let newTeachers = 0
  for (let i = 0; i < teacherCount; i++) {
    const { email, sessionCookie, isNewAccount } = await seedAccount(
      `${prefix}-teacher-${i}@k6.local`,
      `Load Test Teacher ${i}`,
      "TEACHER",
      passwordHash,
      secret
    )
    if (isNewAccount) newTeachers++
    teachers.push({ email, sessionCookie })
  }

  // These files hold live session bearer cookies — .gitignore keeps them out
  // of commits, but doesn't stop other local users/processes from reading
  // them, so restrict to owner-only.
  await mkdir(path.dirname(STUDENTS_OUTPUT_PATH), { recursive: true, mode: 0o700 })
  await writeFile(STUDENTS_OUTPUT_PATH, JSON.stringify(students, null, 2), { mode: 0o600 })
  await writeFile(TEACHERS_OUTPUT_PATH, JSON.stringify(teachers, null, 2), { mode: 0o600 })
  // `mode` above only applies when writeFile creates the file; chmod
  // explicitly so reruns that overwrite an existing file stay owner-only.
  await chmod(STUDENTS_OUTPUT_PATH, 0o600)
  await chmod(TEACHERS_OUTPUT_PATH, 0o600)

  console.log(
    `Created ${newStudents} new student account(s) (${count - newStudents} already existed), ` +
      `${newTeachers} new teacher account(s) (${teacherCount - newTeachers} already existed).`
  )
  console.log(`Minted ${students.length + teachers.length} fresh session(s) in Postgres + Redis, each valid for 7 days.`)
  console.log(`Wrote ${students.length} student credential(s) to ${STUDENTS_OUTPUT_PATH}`)
  console.log(`Wrote ${teachers.length} teacher credential(s) to ${TEACHERS_OUTPUT_PATH}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })
