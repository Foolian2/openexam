import { describe, expect, it } from "vitest"
import nextConfig from "@/next.config.mjs"
import { PUBLIC_ROUTES } from "@/proxy"

// The cap proxy regressed once already (widget endpoint baked to the Cap
// service's direct URL + proxy 307 redirect), and both fixes were verified
// only manually. These assertions pin the two config surfaces that made the
// widget reachable: the rewrite shape and the proxy's public-route list.
describe("cap proxy configuration", () => {
  it("rewrites only site-key-shaped challenge/redeem paths", async () => {
    const rewrites = ((await nextConfig.rewrites?.()) ??
      []) as { source: string; destination: string }[]
    expect(rewrites).toHaveLength(1)
    expect(rewrites[0].source).toBe(
      "/cap-api/:siteKey([a-f0-9]{10})/:action(challenge|redeem)"
    )
    expect(rewrites[0].destination).toContain("/:siteKey/:action")
  })

  it("keeps /cap-api exempt from the proxy auth gate", () => {
    expect(PUBLIC_ROUTES).toContain("/cap-api")
  })
})
