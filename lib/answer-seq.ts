/**
 * Issues the `clientSeq` attached to every answer save.
 *
 * A save can reach Postgres over two paths: the WebSocket (buffered in Redis
 * and flushed every few seconds) or the REST fallback (written directly).
 * Arrival order at Postgres is therefore not edit order, so both write paths
 * only replace a stored answer whose clientSeq is lower than the incoming one.
 *
 * Values are millisecond timestamps, forced strictly increasing, so they keep
 * growing across page reloads without any persisted counter. `observe` raises
 * the floor to what the server already holds, so a device whose clock runs
 * behind the one that wrote those answers still issues higher values instead
 * of having every save rejected as stale.
 */
export interface ClientSeq {
  next(): number
  observe(seq: number | null | undefined): void
}

export function createClientSeq(now: () => number = Date.now): ClientSeq {
  let last = 0
  return {
    next() {
      last = Math.max(now(), last + 1)
      return last
    },
    observe(seq) {
      if (typeof seq === "number" && Number.isFinite(seq) && seq > last)
        last = seq
    },
  }
}
