import { autoGradeSession } from "./grade-session"
import { logError } from "@/lib/logger"
import { gradingRetryFailures } from "@/lib/metrics"

const MAX_ATTEMPTS = 3
const BACKOFF_MS = [250, 1_000]

/**
 * Runs autoGradeSession with bounded retries, never throwing.
 *
 * Grading happens after the submit/close transaction has already committed
 * the status change, so a failure here must not fail the request — and the
 * caller must not silently skip grading on a retried request either (both
 * cases permanently lose the grades). `autoGradeSession` is idempotent and
 * gated on `autoGraded` (manual grades are never clobbered), so re-running
 * it is always safe.
 *
 * On final failure the full context is logged so the event is recoverable
 * from container/log-aggregator output (same philosophy as lib/audit.ts).
 */
export async function gradeWithRetry(sessionId: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await autoGradeSession(sessionId)
      return
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        logError("grading failed after retries", {
          sessionId,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        })
        gradingRetryFailures.inc()
        return
      }
      await new Promise((resolve) =>
        setTimeout(resolve, BACKOFF_MS[attempt - 1])
      )
    }
  }
}
