import client from "prom-client"

// Shared Prometheus registry — a module-global like lib/prisma.ts's client,
// re-registering the same metric on every hot-reload in dev would throw
// ("metric already registered"), so the metrics/counters live on
// globalThis exactly like the Prisma/Redis singletons do.
const globalForMetrics = globalThis as unknown as {
  metricsRegistry?: client.Registry
  gradingRetryFailures?: client.Counter<string>
  rateLimitRejections?: client.Counter<string>
  auditLogWriteFailures?: client.Counter<string>
  answerFilesPruned?: client.Counter<string>
  answerFileBytesPruned?: client.Counter<string>
}

export const registry =
  globalForMetrics.metricsRegistry ??
  (() => {
    const registry = new client.Registry()
    client.collectDefaultMetrics({ register: registry })
    return registry
  })()

// Final-attempt grading failures (lib/grading/grade-with-retry.ts) — the
// exam is submitted but ungraded until a human intervenes, worth alerting on.
export const gradingRetryFailures =
  globalForMetrics.gradingRetryFailures ??
  new client.Counter({
    name: "openexam_grading_retry_failures_total",
    help: "Auto-grading attempts that exhausted all retries",
    registers: [registry],
  })

// Rejections from lib/rate-limit.ts, labeled by fail-open/fail-closed so a
// spike distinguishes real abuse from a Redis outage forcing closed limits.
export const rateLimitRejections =
  globalForMetrics.rateLimitRejections ??
  new client.Counter({
    name: "openexam_rate_limit_rejections_total",
    help: "Requests rejected by the rate limiter",
    labelNames: ["reason"],
    registers: [registry],
  })

// Audit-log DB writes that failed (lib/audit.ts) — each one is also reported
// to GlitchTip individually; this counter is for rate/trend alerting.
export const auditLogWriteFailures =
  globalForMetrics.auditLogWriteFailures ??
  new client.Counter({
    name: "openexam_audit_log_write_failures_total",
    help: "Audit log writes that failed to persist to Postgres",
    registers: [registry],
  })

// Superseded attachments deleted by lib/answer-file-retention.ts, so storage
// reclaimed per run is visible next to Postgres disk usage.
export const answerFilesPruned =
  globalForMetrics.answerFilesPruned ??
  new client.Counter({
    name: "openexam_answer_files_pruned_total",
    help: "Superseded answer attachments deleted by the retention job",
    registers: [registry],
  })

export const answerFileBytesPruned =
  globalForMetrics.answerFileBytesPruned ??
  new client.Counter({
    name: "openexam_answer_file_bytes_pruned_total",
    help: "Bytes of superseded answer attachments deleted by the retention job",
    registers: [registry],
  })

if (process.env.NODE_ENV !== "production") {
  globalForMetrics.metricsRegistry = registry
  globalForMetrics.gradingRetryFailures = gradingRetryFailures
  globalForMetrics.rateLimitRejections = rateLimitRejections
  globalForMetrics.auditLogWriteFailures = auditLogWriteFailures
  globalForMetrics.answerFilesPruned = answerFilesPruned
  globalForMetrics.answerFileBytesPruned = answerFileBytesPruned
}
