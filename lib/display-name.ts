import { z } from "zod"

/**
 * Display-name rule for registration and the profile form, enforced again
 * server-side (lib/auth.ts) because Better Auth's /sign-up/email and
 * /update-user accept any string: a name of only spaces rendered as a blank
 * in grade tables and the monitor, and 5000-character names were stored.
 */
export const displayNameSchema = z
  .string()
  .trim()
  .min(2, "Name muss mindestens 2 Zeichen haben")
  .max(100, "Name darf maximal 100 Zeichen haben")

/** The stored form of a name: surrounding whitespace removed. */
export function normalizeDisplayName(name: string): string {
  return name.trim()
}

const NAME_PATHS = new Set(["/sign-up/email", "/update-user"])

/** German error for an invalid name in an auth request, or null. */
export function displayNameIssue(
  path: string | undefined,
  body: unknown
): string | null {
  if (!path || !NAME_PATHS.has(path)) return null
  const name = (body as { name?: unknown } | undefined)?.name
  // /update-user without a name (e.g. accessibility settings) is fine.
  if (name === undefined && path === "/update-user") return null
  const parsed = displayNameSchema.safeParse(name)
  return parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "Ungültiger Name")
}
