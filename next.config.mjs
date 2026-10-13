const isDev = process.env.NODE_ENV === "development"

// Self-hosted Cap CAPTCHA, reached via the same-origin /cap-api/ proxy.
const capOrigin = process.env.CAP_ORIGIN ?? "http://localhost:8090"

// Exact WebSocket origin for connect-src; never use a bare ws:/wss: wildcard.
const wsOrigin = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(
  /^http/,
  "ws"
)

// Enforced CSP. jsdelivr serves Monaco and the Cap widget; 'wasm-unsafe-eval'
// is for Cap's proof-of-work; frame-src 'self' is needed by Cap's iframe check.
// Dev adds 'unsafe-eval': React uses eval() there to rebuild server callstacks
// and logs a console error on every page without it. Production never does.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${
    isDev ? " 'unsafe-eval'" : ""
  } https://cdn.jsdelivr.net`,
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  `connect-src 'self' https://cdn.jsdelivr.net ${wsOrigin}${
    isDev ? " ws://localhost:8080 http://localhost:9000" : ""
  }`,
  "worker-src 'self' blob: https://cdn.jsdelivr.net",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://login.microsoftonline.com",
].join("; ")

// Not wrapped in withSentryConfig: it hardcodes a *.sentry.io tunnel, and we
// use self-hosted GlitchTip (see instrumentation.ts).
/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    // DISABLE_CAPTCHA only skips the server-side check; without this the widget
    // still tries to solve against a site key that was never registered. Only
    // in `next dev`, where lib/auth.ts and the teacher-register route both skip
    // the check too.
    NEXT_PUBLIC_CAPTCHA_DISABLED:
      isDev && process.env.DISABLE_CAPTCHA === "true" ? "true" : "",
  },
  experimental: {
    // proxy.ts matches /api/**, so Next buffers those request bodies (10MB by
    // default). Uploads go up to 25MB (lib/upload-budget.ts); match nginx's
    // 26m /upload cap so a full file plus multipart overhead gets through.
    proxyClientMaxBodySize: "26mb",
  },
  // `next start` refuses standalone output, so the e2e job builds a plain
  // server via E2E_NONSTANDALONE. Docker keeps standalone.
  output: process.env.E2E_NONSTANDALONE === "true" ? undefined : "standalone",
  reactCompiler: true,
  // @react-pdf/renderer bundles react-reconciler internals that must not be
  // bundled with the app when rendering PDFs in Node route handlers.
  serverExternalPackages: ["@react-pdf/renderer"],
  // nft misses parts of @swc/helpers under pnpm, crashing the standalone
  // image at boot. Keep the glob version-agnostic.
  outputFileTracingIncludes: {
    "/*": ["node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**/*"],
    // Font.register reads these at runtime; trace them for standalone exports.
    "/api/exams/*/print": ["public/fonts/dejavu/**/*"],
    "/api/sessions/*/print": ["public/fonts/dejavu/**/*"],
  },
  async rewrites() {
    // Same-origin proxy for Cap (mirrors nginx/nginx.conf). Keep the path
    // pattern narrow: only challenge and redeem are forwarded.
    return [
      {
        source: "/cap-api/:siteKey([a-f0-9]{10})/:action(challenge|redeem)",
        destination: `${capOrigin}/:siteKey/:action`,
      },
    ]
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No effect over plain HTTP (dev); takes effect once served over HTTPS in prod.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
      {
        // Uploaded files (lib/answer-file-headers.ts). Config headers override
        // the route's own `sandbox` CSP, and the later rule wins, so this must
        // stay after the global rule.
        source: "/api/sessions/:id/download/file",
        headers: [{ key: "Content-Security-Policy", value: "sandbox" }],
      },
    ]
  },
}

export default nextConfig
