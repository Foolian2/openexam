/**
 * Creates a password login for a TEACHER or ADMIN account directly in the
 * database — the first account on a fresh install. Self-registration
 * (app/api/teacher/register/route.ts) needs TEACHER_ACCESS_CODE, a solved
 * captcha AND a working SMTP server for the verification mail, so on day one
 * there is otherwise no way in. `./openexam install` runs this at the end;
 * `./openexam create-teacher` runs it on its own.
 *
 * Writes the same two rows a verified registration ends up with: the user
 * (emailVerified=true, lowercase email — sign-in compares lowercase) and its
 * `credential` account, keyed (providerId, accountId=user.id) the way
 * better-auth and scripts/seed-demo.ts key it.
 *
 * Idempotent: an existing email is reported and left alone. --reset-password
 * replaces that account's password (and creates its credential row when it
 * only had Microsoft login) without touching its role.
 *
 * The password comes from the TEACHER_PASSWORD environment variable, never
 * argv, so it doesn't show up in `ps` or shell history. Runs inside the
 * `migrate` image like scripts/seed-demo.ts, bind-mounted so the deployed
 * images stay untouched:
 *
 *   docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
 *     --no-deps -v "$PWD/scripts/create-teacher.ts:/app/scripts/create-teacher.ts:ro" \
 *     -e TEACHER_PASSWORD \
 *     migrate pnpm tsx scripts/create-teacher.ts --email a@b.ch --name "A B" --role ADMIN
 *
 * In development: TEACHER_PASSWORD=… pnpm tsx --env-file=.env scripts/create-teacher.ts …
 */
import { pathToFileURL } from "node:url"
import { z } from "zod"

export const MIN_PASSWORD_LENGTH = 12
// better-auth's default maxPasswordLength; a longer one could never sign in.
export const MAX_PASSWORD_LENGTH = 128

export type CreateTeacherOptions = {
  email: string
  /** Only used when the account is created; a password reset keeps the old one. */
  name?: string
  role: "TEACHER" | "ADMIN"
  password: string
  resetPassword: boolean
}

const optionsSchema = z.object({
  email: z
    .string()
    .trim()
    .email("--email must be a valid email address")
    .max(255)
    .transform((e) => e.toLowerCase()),
  name: z
    .string()
    .trim()
    .min(2, "--name needs at least 2 characters")
    .max(100)
    .optional(),
  role: z.enum(["TEACHER", "ADMIN"], {
    error: "--role must be TEACHER or ADMIN",
  }),
  password: z
    .string({ error: "TEACHER_PASSWORD must be set in the environment" })
    .min(
      MIN_PASSWORD_LENGTH,
      `TEACHER_PASSWORD needs at least ${MIN_PASSWORD_LENGTH} characters`
    )
    .max(
      MAX_PASSWORD_LENGTH,
      `TEACHER_PASSWORD can have at most ${MAX_PASSWORD_LENGTH} characters`
    ),
  resetPassword: z.boolean(),
})

/** Parses argv + env into options, or a list of human-readable problems. */
export function parseCreateTeacherArgs(
  argv: string[],
  env: Record<string, string | undefined>
):
  | { ok: true; options: CreateTeacherOptions }
  | { ok: false; errors: string[] } {
  const raw: Record<string, string | boolean | undefined> = {
    role: "TEACHER",
    resetPassword: false,
  }
  const errors: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf("=")
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)
    const takeValue = () => (inline !== undefined ? inline : argv[++i])
    switch (flag) {
      case "--email":
        raw.email = takeValue()
        break
      case "--name":
        raw.name = takeValue()
        break
      case "--role":
        raw.role = takeValue()?.toUpperCase()
        break
      case "--reset-password":
        raw.resetPassword = true
        break
      default:
        errors.push(`unknown argument: ${arg}`)
    }
  }
  if (raw.email === undefined) errors.push("--email is required")
  if (raw.name === undefined && !raw.resetPassword) {
    errors.push("--name is required")
  }

  const parsed = optionsSchema.safeParse({
    ...raw,
    password: env.TEACHER_PASSWORD,
  })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // Missing flags were already reported above in plainer words.
      if (issue.code === "invalid_type" && issue.path[0] !== "password")
        continue
      errors.push(issue.message)
    }
  }
  if (errors.length > 0 || !parsed.success) {
    return { ok: false, errors }
  }
  return { ok: true, options: parsed.data }
}

export type CreateTeacherResult = "created" | "exists" | "password-reset"

export async function createTeacher(
  options: CreateTeacherOptions
): Promise<CreateTeacherResult> {
  // Imported lazily so the argument parser above stays testable without a
  // database (lib/prisma.ts throws at import time without DATABASE_URL).
  const { prisma } = await import("@/lib/prisma")
  const { hashPassword } = await import("better-auth/crypto")

  const existing = await prisma.user.findUnique({
    where: { email: options.email },
    select: { id: true },
  })

  if (existing && !options.resetPassword) return "exists"

  const password = await hashPassword(options.password)

  if (existing) {
    const credential = await prisma.account.findFirst({
      where: { userId: existing.id, providerId: "credential" },
      select: { id: true },
    })
    await prisma.$transaction([
      credential
        ? prisma.account.update({
            where: { id: credential.id },
            data: { password },
          })
        : prisma.account.create({
            data: {
              userId: existing.id,
              accountId: existing.id,
              providerId: "credential",
              password,
            },
          }),
      // A reset is also how a locked-out admin gets back in, so a stale
      // unverified flag must not keep them out.
      prisma.user.update({
        where: { id: existing.id },
        data: { emailVerified: true },
      }),
      // Sign out everywhere: whoever knew the old password keeps no session.
      prisma.session.deleteMany({ where: { userId: existing.id } }),
    ])
    return "password-reset"
  }

  const name = options.name
  if (!name) throw new Error("--name is required to create an account")
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: options.email,
        name,
        role: options.role,
        emailVerified: true,
      },
    })
    await tx.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password,
      },
    })
  })
  return "created"
}

async function main() {
  const parsed = parseCreateTeacherArgs(process.argv.slice(2), process.env)
  if (!parsed.ok) {
    for (const e of parsed.errors) console.error(`error: ${e}`)
    process.exit(2)
  }
  const { options } = parsed
  const result = await createTeacher(options)
  switch (result) {
    case "created":
      console.log(`Created ${options.role} account ${options.email}.`)
      break
    case "exists":
      console.log(
        `An account for ${options.email} already exists — left unchanged (pass --reset-password to set a new password).`
      )
      break
    case "password-reset":
      console.log(
        `Password for ${options.email} reset; its sessions were signed out.`
      )
      break
  }
  const { prisma } = await import("@/lib/prisma")
  await prisma.$disconnect()
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
