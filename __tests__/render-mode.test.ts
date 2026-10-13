import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * A page that reads deployment configuration from process.env but no
 * request-time API (cookies/headers/searchParams/params) is prerendered at
 * BUILD time — and the Docker build carries none of the deployment's real
 * values. That silently froze microsoftEnabled=false into /register and
 * /register-teacher, hiding the Microsoft sign-in button in every deployment
 * that had it configured.
 *
 * Such a page must defer to request time with `await connection()` (or the
 * older `export const dynamic = "force-dynamic"`). This is a source-level
 * check because the failure only shows up in the build output.
 */
const ENV_DEPENDENT =
  /microsoftConfigured|getLegalConfig|getPrivacyPolicyVersion/
const REQUEST_TIME =
  /await connection\(\)|dynamic = "force-dynamic"|await headers\(\)|await cookies\(\)|await searchParams|await params/

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return pageFiles(path)
    return entry.name === "page.tsx" || entry.name === "layout.tsx"
      ? [path]
      : []
  })
}

const envDependentPages = pageFiles("app").filter((file) =>
  ENV_DEPENDENT.test(readFileSync(file, "utf8"))
)

describe("pages reading deployment config render at request time", () => {
  it("finds the pages this rule is about", () => {
    // Guards against the regex silently matching nothing after a rename.
    expect(envDependentPages.length).toBeGreaterThanOrEqual(4)
  })

  it.each(envDependentPages)("%s defers to request time", (file) => {
    expect(REQUEST_TIME.test(readFileSync(file, "utf8"))).toBe(true)
  })
})
