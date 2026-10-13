import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { configKeyTokenForUrl } from "@/lib/seb-key"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/redis", () => ({ redis: { publish: vi.fn() } }))

const { decideBekAction } = await import("@/lib/seb-guard")

/**
 * The other half of ws-backend/internal/seb/seb_test.go's
 * TestSharedTokenVectors. Both read the same table, so the TypeScript
 * implementation (the only place the Config Key algorithm lives) and the Go
 * verifier cannot drift apart without one of these two suites going red.
 *
 * The same construction backs the Config Key token and the Browser Exam Key
 * RequestHash, so this covers both.
 *
 * bekVectors is the other half of ws-backend/main_test.go's
 * TestSebIntegrityDecision_SharedVectors: both run the same table against
 * their own BEK decision rule (decideBekAction here, sebIntegrityDecision in
 * Go) so the REST and WS transports keep flagging the same situations.
 */
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "testdata", "seb-token-vectors.json"),
    "utf8"
  )
) as {
  vectors: { name: string; url: string; key: string; expected: string }[]
  bekVectors: {
    name: string
    bound: string | null
    presented: string
    alreadyFlagged: boolean
    action: "noop" | "bind" | "flag"
    reason: "bek_changed" | "bek_disappeared" | null
  }[]
}

describe("shared SEB token vectors", () => {
  it("has vectors to check", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0)
  })

  it.each(fixture.vectors)("$name", ({ url, key, expected }) => {
    expect(configKeyTokenForUrl(url, key)).toBe(expected)
  })
})

describe("shared BEK decision vectors", () => {
  it("has vectors to check", () => {
    expect(fixture.bekVectors.length).toBeGreaterThan(0)
  })

  it.each(fixture.bekVectors)("$name", (v) => {
    const result = decideBekAction({
      bound: v.bound,
      presented: v.presented,
      presentedMatches:
        v.bound !== null && v.bound !== "" && v.bound === v.presented,
      alreadyFlagged: v.alreadyFlagged,
    })
    expect(result).toEqual({ action: v.action, reason: v.reason ?? undefined })
  })
})
