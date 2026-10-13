/**
 * Kept separate from lib/seb-guard.ts so callers don't pull in Prisma/Redis.
 *
 * Not an authorization signal on its own; callers rely only on the negative
 * (a request without it did not come from SEB).
 */
export function isSEBUserAgent(userAgent: string): boolean {
  return userAgent.includes("SEB/")
}
