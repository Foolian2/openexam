import { defineConfig, devices } from "@playwright/test"

// CI runs on a shared self-hosted box where port 3000 may already be bound
// by something outside the job (same class of problem as the Postgres 5432
// clash — see ci.yml), so the E2E server port is overridable via E2E_PORT.
// Test files build their Origin header from the same variable.
// CI runs the suite against a real production build (selected via
// E2E_PROD_SERVER in ci.yml): more realistic than dev mode, and a fraction
// of the memory — the turbopack dev server grew past 11G RSS on 2026-08-20
// and thrash-swapped the dedicated runner offline, while a prod server for
// this app sits in the low hundreds of MB. The e2e job builds with
// E2E_NONSTANDALONE=true (next.config.mjs) so the plain `next start` works
// (standalone output + `next start` are mutually exclusive). Local runs keep
// `pnpm dev` for iteration speed.
const prodServer = process.env.E2E_PROD_SERVER === "true"
const port = Number(process.env.E2E_PORT ?? 3000)
const baseURL =
  process.env.E2E_BASE_URL ??
  process.env.TARGET_BASE_URL ??
  `http://localhost:${port}`

/**
 * E2E tests drive the real app against the local Docker infra
 * (postgres/redis). Start it first: `docker-compose up -d`.
 * The dev server is started automatically unless one is already running.
 */
export default defineConfig({
  testDir: "e2e",
  // e2e/stress/ has its own config (playwright.stress.config.ts, run via
  // `pnpm test:stress`) with longer timeouts and no auto-started webServer.
  // Under this config those tests only burn retries: T3 alone waits ~100s
  // for a real deadline, and each 120s timeout × 3 attempts stretched the
  // CI E2E job to ~14 minutes.
  testIgnore: "**/stress/**",
  fullyParallel: true,
  // Spec files share one IP-keyed auth rate-limit budget (lib/auth.ts); running
  // them in separate parallel workers in CI races them against each other for
  // that budget. Force one worker in CI to avoid cross-file collisions (the
  // helpers still retry on 429 as a second line of defense, and one dedicated
  // test in toctou-fixes.spec.ts intentionally exercises the limiter itself).
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Generous enough to absorb one full 60s rate-limit reset wait inside a
  // beforeAll hook that makes multiple sign-up/sign-in calls (see helpers.ts).
  timeout: process.env.CI ? 120_000 : undefined,
  reporter: process.env.CI ? "github" : "list",
  // Default 5s is too tight for the very first request to a given route on a
  // freshly-started `pnpm dev` server: Turbopack compiles routes on demand,
  // and that first compile can push a self-hosted CI runner's response time
  // well past 5s under load, failing the assertion and cascading into
  // timeouts on every test that runs after (seen failing auth.spec.ts's
  // first sign-up assertion in CI while passing reliably locally).
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  use: {
    baseURL,
    // proxy.ts rejects mutating /api/* requests that carry no Origin, as a
    // browser always sends one. The test runner applies these options to
    // every browser context *and* every playwright.request.newContext() that
    // doesn't set extraHTTPHeaders itself, so API-level setup calls pass too.
    extraHTTPHeaders: { origin: new URL(baseURL).origin },
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "true",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer:
    process.env.E2E_EXISTING_SERVER === "true"
      ? undefined
      : {
          command: prodServer ? `pnpm start -p ${port}` : `pnpm dev -p ${port}`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
})
