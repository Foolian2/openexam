import { defineConfig, devices } from "@playwright/test"

const baseURL =
  process.env.E2E_BASE_URL ??
  process.env.TARGET_BASE_URL ??
  `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`

/**
 * Real-browser stress tests for client-visible correctness under
 * moderate concurrency. These complement the k6 protocol-level suite:
 * k6 verifies performance targets (p95 < 200ms REST, < 100ms WS) at
 * scale; these verify correctness (answer persistence, timer survival,
 * time extension delivery, REST fallback, no cross-session bleed) that
 * only real browser execution can confirm.
 *
 * Separate config from `playwright.config.ts` so stress tests don't
 * run on every `pnpm test:e2e` and can use different settings:
 *   - Higher timeouts (real browser contexts are slow)
 *   - Serial worker (browser contexts are memory-heavy)
 *   - No auto-starting webServer (expects infra to be running)
 */
export default defineConfig({
  testDir: "e2e/stress",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    // TARGET_BASE_URL points the suite at a remote deployment (the benchmark
    // VPS) instead of a local stack — page-load-under-load.spec.ts needs to
    // measure the real server over the real network. Self-signed TLS is
    // expected there, hence ignoreHTTPSErrors.
    baseURL,
    // proxy.ts rejects mutating /api/* requests without an Origin; see the
    // same option in playwright.config.ts.
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
