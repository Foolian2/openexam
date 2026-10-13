import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// nginx micro-caches the logged-out landing render and shares it between
// visitors (see `location = /` in nginx/nginx.conf). Every assertion here
// guards a way that sharing could go wrong — serving one visitor's page to
// another — which `nginx -t` cannot catch because each of them is valid
// configuration, just the wrong one.
const conf = readFileSync(
  fileURLToPath(new URL("../nginx/nginx.conf", import.meta.url)),
  "utf8"
)

/** The body of the first `location <match> {` block, brace-matched. */
function locationBlock(match: string): string {
  const start = conf.indexOf(`location ${match} {`)
  expect(start, `location ${match} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = conf.indexOf("{", start); i < conf.length; i++) {
    if (conf[i] === "{") depth++
    else if (conf[i] === "}" && --depth === 0)
      return conf.slice(conf.indexOf("{", start) + 1, i)
  }
  throw new Error(`unbalanced braces in location ${match}`)
}

describe("anonymous landing-page cache", () => {
  const block = locationBlock("= /")

  it("caches the landing page and nothing else", () => {
    expect(block).toMatch(/proxy_cache\s+landing;/)
    // One cached location, so a future block can't quietly start sharing a
    // personalized page under the same zone.
    expect(conf.match(/^\s*proxy_cache\s+\w+;/gm)).toHaveLength(1)
  })

  it("keeps logged-in visitors out of the shared copy, both ways round", () => {
    // bypass alone would still *store* the personalized render.
    expect(block).toMatch(/proxy_cache_bypass\s+\$openexam_has_session;/)
    expect(block).toMatch(/proxy_no_cache\s+\$openexam_has_session;/)
  })

  it("leaves Set-Cookie out of proxy_ignore_headers", () => {
    // nginx refuses to cache a response carrying Set-Cookie unless it is
    // ignored here — the backstop if this page ever sets one anonymously.
    const ignored = block.match(/proxy_ignore_headers([^;]*);/)
    expect(ignored).not.toBeNull()
    expect(ignored?.[1]).not.toMatch(/Set-Cookie/i)
  })

  it("collapses a cold-miss stampede instead of forwarding all of it", () => {
    expect(block).toMatch(/proxy_cache_lock\s+on;/)
    expect(block).toMatch(/proxy_cache_use_stale[^;]*updating/)
    expect(block).toMatch(/proxy_cache_background_update\s+on;/)
  })

  it("holds the shared copy only briefly", () => {
    const valid = block.match(/proxy_cache_valid\s+200\s+(\d+)s;/)
    expect(valid).not.toBeNull()
    expect(Number(valid?.[1])).toBeLessThanOrEqual(60)
  })
})

describe("$openexam_has_session", () => {
  // The regex is matched against the raw Cookie header because nginx variable
  // names can't contain the dot in `better-auth.session_token`. If it ever
  // stops matching, every logged-in visitor silently gets the cached
  // anonymous page — so the pattern itself is exercised here.
  const source = conf.match(
    /map \$http_cookie \$openexam_has_session \{[^}]*"~\*([^"]+)"\s+1;/
  )?.[1]

  it("is defined as a case-insensitive cookie-name match", () => {
    expect(source).toBeDefined()
  })

  it.each([
    ["better-auth.session_token=abc", true],
    ["__Secure-better-auth.session_token=abc", true],
    ["theme=dark; __Secure-better-auth.session_token=abc; a=b", true],
    ["theme=dark", false],
    ["", false],
    // A cookie merely *named* after the session must not count — only an
    // actual `name=` assignment does.
    ["note=better-auth.session_token", false],
  ])("matches %j -> %s", (cookie, expected) => {
    // nginx's "~*" prefix is an unanchored, case-insensitive regex.
    expect(new RegExp(source!, "i").test(cookie)).toBe(expected)
  })
})
