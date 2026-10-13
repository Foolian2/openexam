import * as Sentry from "@sentry/nextjs"

// GlitchTip must stay unreachable from the internet (SSH-tunnel-only admin
// UI, per DEPLOYMENT.md), but a normal Sentry-SDK browser client POSTs
// straight to its DSN host. The `tunnel` option instead routes every event
// through our own same-origin API route (app/api/monitoring/tunnel), which
// relays it server-side to glitchtip-web over the internal Docker network —
// so the browser never needs a public GlitchTip endpoint, and no CSP change
// is needed (connect-src 'self' already covers a same-origin POST).
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tunnel: "/api/monitoring/tunnel",
    tracesSampleRate: 0,
  })
}
