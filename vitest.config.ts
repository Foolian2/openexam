import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // Node by default; hook and component tests opt into a DOM per file with
    // `// @vitest-environment happy-dom`.
    environment: "node",
    include: ["__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["__tests__/setup/dom.ts"],
    // Tests assert on returned values, not log lines; pino's pretty stack
    // traces from deliberately-failing paths only buried real failures.
    // LOG_LEVEL is read by lib/logger.ts.
    env: { LOG_LEVEL: "silent" },
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "hooks/**/*.ts", "components/**/*.tsx"],
      exclude: [
        "lib/prisma.ts",
        "lib/redis.ts",
        "lib/seb-client.ts",
        "lib/seb-default-root-settings.json",
        // Generated shadcn primitives, not our code.
        "components/ui/**",
      ],
      // The top-level numbers apply to every measured file combined; each
      // glob is checked on its own on top of that. components/ mostly has no
      // tests yet, so its floor (and the combined one it drags down) is a
      // ratchet to raise as component tests are added, not a target.
      thresholds: {
        branches: 28,
        functions: 26,
        lines: 31,
        statements: 32,
        "components/**/*.tsx": {
          branches: 3,
          functions: 4,
          lines: 3,
          statements: 3,
        },
        "lib/**/*.ts": {
          branches: 72,
          functions: 78,
          lines: 78,
          statements: 78,
        },
        "hooks/**/*.ts": {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        // Security-critical files are held to their own bar individually, so
        // a well-covered neighbour can't mask a regression in one of them.
        "lib/seb-config.ts": {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        "lib/seb-key.ts": {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        "lib/seb-guard.ts": {
          branches: 90,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        "hooks/use-exam-socket.ts": {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
      },
    },
  },
})
