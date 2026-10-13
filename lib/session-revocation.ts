import { Prisma } from "@/generated/prisma/client"
import { redis } from "@/lib/redis"
import { logError } from "@/lib/logger"

/**
 * Deletes a user's session rows inside an already-running transaction and
 * returns their tokens for the Redis purge that must follow the commit.
 *
 * Doing the read and the delete in the same transaction as the role change
 * closes two holes the old read-then-delete pair left open:
 *  - a session created between the read and the delete kept its Redis
 *    snapshot, which better-auth's secondary storage would keep serving
 *    even though the row was gone;
 *  - a crash between the role update and the delete left a demoted user's
 *    sessions fully intact.
 * Rows created after the commit carry the new role, so nothing here needs
 * to know about them.
 */
export async function revokeUserSessionsInTx(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<string[]> {
  const stale = await tx.session.findMany({
    where: { userId },
    select: { token: true },
  })
  await tx.session.deleteMany({ where: { userId } })
  return stale.map((s) => s.token)
}

/**
 * Purges the Redis session snapshots for the given tokens, retrying once.
 * The DB rows are already gone (ws-backend auth reads Postgres only), but
 * better-auth serves getSession from the secondary storage first — a
 * surviving Redis snapshot keeps the revoked session (and its stale role)
 * valid until its TTL. That makes this a fail-loud security path, unlike
 * most of the repo's best-effort Redis writes.
 *
 * Returns the number of snapshots that survived both attempts.
 */
export async function purgeSessionRedisKeys(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0

  const attempt = async () => {
    const results = await Promise.allSettled(tokens.map((t) => redis.del(t)))
    return results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected"
    ).length
  }

  let failed = await attempt()
  if (failed > 0) failed = await attempt()
  if (failed > 0) {
    logError(
      `session-revocation: ${failed}/${tokens.length} Redis session snapshots could not be deleted; the revoked sessions stay valid until their TTL expires`,
      { failed, total: tokens.length }
    )
  }
  return failed
}
