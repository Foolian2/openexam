export async function register() {
  // Skip during `next build` (page-data collection spawns the instrumentation
  // hook too): build environments don't carry runtime secrets, and failing
  // there would break CI/CD. Validation matters when the real server starts.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { validateEnv } = await import("@/lib/env")
    try {
      validateEnv()
    } catch {
      process.exit(1)
    }
    if (process.env.NODE_ENV === "production") {
      const { startDeadlineSweeper } = await import("@/lib/deadline-sweeper")
      startDeadlineSweeper()
      const { startAnswerFileRetention } =
        await import("@/lib/answer-file-retention")
      startAnswerFileRetention()
    }
  }

  // GlitchTip (self-hosted, Sentry-protocol-compatible error tracker) init.
  // SENTRY_DSN points at the internal-only glitchtip-web:8000 address — this
  // is ordinary container-to-container traffic (web is already on the
  // `internal` network, same as its Postgres/Redis calls), so no tunnel is
  // needed server-side. Client-side capture uses a tunnel; see
  // instrumentation-client.ts. Skipped entirely when SENTRY_DSN is unset so
  // deployments that opt out of the monitoring stack (scripts/setup-monitoring.sh
  // is optional) see no behavior change.
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build" &&
    process.env.SENTRY_DSN
  ) {
    const Sentry = await import("@sentry/nextjs")
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0,
      // Sends events, not performance traces — this is an error tracker for
      // a resource-constrained self-hosted box, not an APM product.
    })
  }
}

export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) {
  if (!process.env.SENTRY_DSN) return
  const Sentry = await import("@sentry/nextjs")
  Sentry.captureRequestError(...args)
}
