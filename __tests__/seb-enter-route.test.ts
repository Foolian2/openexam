import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const verifyOneTimeTokenMock = vi.fn()
const getSessionMock = vi.fn()
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      verifyOneTimeToken: (...args: unknown[]) =>
        verifyOneTimeTokenMock(...args),
      getSession: (...args: unknown[]) => getSessionMock(...args),
    },
  },
}))

const rateLimitMock = vi.fn()
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
}))

const { GET } = await import("@/app/exam/[id]/seb-enter/route")

// The public origin, deliberately different from the internal address the
// container actually binds — which is the whole point of these tests.
const baseUrl = "https://openexam.ch"

// Every genuine request to this route comes from SEB, so the SEB User-Agent is
// the default here — its absence is the attack, and gets its own tests below.
const SEB_UA =
  "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.118 SEB/3.10.2 (x64)"

function request(url: string, userAgent: string = SEB_UA) {
  return new NextRequest(
    new Request(url, { headers: { "user-agent": userAgent } })
  )
}

const params = { params: Promise.resolve({ id: "exam1" }) }

beforeEach(() => {
  verifyOneTimeTokenMock.mockReset()
  getSessionMock.mockReset()
  // Cookieless is the genuine case: SEB starts its exam session with a cleared
  // cookie jar, which is the entire reason this route exists.
  getSessionMock.mockResolvedValue(null)
  rateLimitMock.mockReset()
  rateLimitMock.mockResolvedValue({ allowed: true, resetInSeconds: 60 })
  process.env.NEXT_PUBLIC_BASE_URL = baseUrl
})

describe("GET /exam/[id]/seb-enter rate limit", () => {
  it("throttles redemption per exam and client IP, fail-closed", async () => {
    verifyOneTimeTokenMock.mockResolvedValue(new Response(null))
    await GET(
      new NextRequest(
        new Request(`${baseUrl}/exam/exam1/seb-enter?ott=tok`, {
          headers: { "user-agent": SEB_UA, "x-forwarded-for": "9.9.9.9" },
        })
      ),
      params
    )
    expect(rateLimitMock).toHaveBeenCalledWith(
      "seb-enter:exam1:9.9.9.9",
      200,
      60,
      "closed"
    )
  })

  it("does not redeem the token when over the limit and falls back to the take page", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, resetInSeconds: 30 })
    const res = await GET(
      request(`${baseUrl}/exam/exam1/seb-enter?ott=tok`),
      params
    )
    expect(verifyOneTimeTokenMock).not.toHaveBeenCalled()
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
    expect(res.headers.get("set-cookie")).toBeNull()
  })
})

describe("GET /exam/[id]/seb-enter", () => {
  it("redirects to the PUBLIC take URL even when the request arrives on the container's internal address", async () => {
    // The regression this file exists for. Behind nginx the web container sees
    // its own bind address, so `new URL(path, request.url)` produced
    // http://0.0.0.0:3000/... — an unreachable host, handed to a browser with
    // no address bar. Caught in production; never again.
    const res = await GET(
      request("http://0.0.0.0:3000/exam/exam1/seb-enter"),
      params
    )
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
  })

  it("redirects without consuming anything when no token is present", async () => {
    const res = await GET(request(`${baseUrl}/exam/exam1/seb-enter`), params)
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
    expect(verifyOneTimeTokenMock).not.toHaveBeenCalled()
  })

  it("forwards every Set-Cookie header the redemption issued", async () => {
    // getSetCookie() rather than headers.get(): folding several cookies into
    // one comma-joined string yields a cookie the browser discards, and the
    // student silently lands on /login despite a valid token.
    const headers = new Headers()
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly")
    headers.append("set-cookie", "session_data=xyz; Path=/; HttpOnly")
    verifyOneTimeTokenMock.mockResolvedValue({ ok: true, headers })

    const res = await GET(
      request(`${baseUrl}/exam/exam1/seb-enter?ott=good-token`),
      params
    )
    expect(res.headers.getSetCookie()).toEqual([
      "session=abc; Path=/; HttpOnly",
      "session_data=xyz; Path=/; HttpOnly",
    ])
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
  })

  it("degrades to the manual login on a rejected token instead of erroring", async () => {
    verifyOneTimeTokenMock.mockResolvedValue({
      ok: false,
      headers: new Headers(),
    })
    const res = await GET(
      request(`${baseUrl}/exam/exam1/seb-enter?ott=expired`),
      params
    )
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it("degrades to the manual login when redemption throws, never stranding the student", async () => {
    verifyOneTimeTokenMock.mockRejectedValue(new Error("auth backend down"))
    const res = await GET(
      request(`${baseUrl}/exam/exam1/seb-enter?ott=boom`),
      params
    )
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
  })
})

describe("GET /exam/[id]/seb-enter — login CSRF", () => {
  // Redeeming an OTT mints a session cookie for whoever owns the token. Any
  // student can mint one for themselves (the launch page embeds it in its
  // seb:// href, readable in page source), so without these guards a link sent
  // to a classmate silently authenticates that classmate's browser as the
  // sender — who then sits the exam writing answers into the sender's session.

  it("refuses to redeem for a normal browser, which is where the attack lands", async () => {
    const res = await GET(
      request(
        `${baseUrl}/exam/exam1/seb-enter?ott=attacker-token`,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
      ),
      params
    )

    // The token is never even presented: a victim's browser cannot claim SEB in
    // its User-Agent, and the attacker controls their own UA, not the victim's.
    expect(verifyOneTimeTokenMock).not.toHaveBeenCalled()
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
    expect(res.headers.getSetCookie()).toHaveLength(0)
  })

  it("refuses when the request already carries a session, rather than overwriting it", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "victim" } })

    const res = await GET(
      request(`${baseUrl}/exam/exam1/seb-enter?ott=attacker-token`),
      params
    )

    expect(verifyOneTimeTokenMock).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie()).toHaveLength(0)
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
  })

  it("does not burn the token when a precondition fails", async () => {
    // Checked before redeeming, so a request that should never have reached
    // here cannot consume the student's single-use token as a side effect and
    // strand them on a manual login.
    getSessionMock.mockResolvedValue({ user: { id: "someone" } })
    await GET(request(`${baseUrl}/exam/exam1/seb-enter?ott=t`), params)
    expect(verifyOneTimeTokenMock).not.toHaveBeenCalled()
  })

  it("still completes the handoff for a genuine SEB request", async () => {
    // The guards must not break the flow they protect: SEB, cookieless.
    const headers = new Headers()
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly")
    verifyOneTimeTokenMock.mockResolvedValue({ ok: true, headers })

    const res = await GET(
      request(`${baseUrl}/exam/exam1/seb-enter?ott=good`),
      params
    )

    expect(verifyOneTimeTokenMock).toHaveBeenCalledTimes(1)
    expect(res.headers.getSetCookie()).toEqual([
      "session=abc; Path=/; HttpOnly",
    ])
    expect(res.headers.get("location")).toBe(`${baseUrl}/exam/exam1/take`)
  })

  it("accepts the macOS SEB User-Agent too", async () => {
    const headers = new Headers()
    headers.append("set-cookie", "session=abc")
    verifyOneTimeTokenMock.mockResolvedValue({ ok: true, headers })

    await GET(
      request(
        `${baseUrl}/exam/exam1/seb-enter?ott=good`,
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 SEB/3.7.1"
      ),
      params
    )

    expect(verifyOneTimeTokenMock).toHaveBeenCalledTimes(1)
  })
})
