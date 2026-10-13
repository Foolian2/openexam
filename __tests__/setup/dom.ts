import { afterEach } from "vitest"

// Every suite loads this file, but only DOM suites (`@vitest-environment
// happy-dom`) need the jest-dom matchers and RTL cleanup — skip the import
// cost for the Node suites.
if (typeof document !== "undefined") {
  await import("@testing-library/jest-dom/vitest")
  const { cleanup } = await import("@testing-library/react")
  afterEach(() => cleanup())
}
