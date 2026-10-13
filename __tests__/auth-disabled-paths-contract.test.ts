import { describe, expect, it } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { oneTimeToken } from "better-auth/plugins/one-time-token"

import { AUTH_DISABLED_PATHS } from "@/lib/auth-disabled-paths"

// Pins AUTH_DISABLED_PATHS against the installed better-auth: the SEB
// one-time-token endpoints must 404 over HTTP (including URL spellings that
// reach the same route) while the server-side auth.api round trip used by
// launch-seb/seb-enter keeps working. If an upgrade renames the endpoints or
// moves the disabledPaths check, these fail instead of the block going quiet.

const BASE = "http://localhost:3000"

function setup() {
  return betterAuth({
    secret: "auth-disabled-paths-contract-test-secret-0123",
    baseURL: BASE,
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    disabledPaths: AUTH_DISABLED_PATHS,
    plugins: [oneTimeToken({ storeToken: "hashed" })],
  })
}

type Auth = ReturnType<typeof setup>

async function signedInHeaders(auth: Auth): Promise<Headers> {
  const res = await auth.api.signUpEmail({
    body: {
      email: "student@example.com",
      password: "correct-horse-battery",
      name: "Student",
    },
    asResponse: true,
  })
  const cookie = res.headers.get("set-cookie")
  expect(cookie).toBeTruthy()
  return new Headers({ cookie: cookie!.split(";")[0] })
}

describe("one-time-token endpoints are server-only", () => {
  it("still round-trips through auth.api", async () => {
    const auth = setup()
    const headers = await signedInHeaders(auth)

    const { token } = await auth.api.generateOneTimeToken({ headers })
    const verified = await auth.api.verifyOneTimeToken({ body: { token } })

    expect(verified.user.email).toBe("student@example.com")
    expect(verified.session.token).toBeTruthy()
  })

  it("still sets the session cookie in seb-enter's call shape", async () => {
    const auth = setup()
    const headers = await signedInHeaders(auth)
    const { token } = await auth.api.generateOneTimeToken({ headers })

    // Exactly how app/exam/[id]/seb-enter/route.ts redeems: it forwards
    // this response's Set-Cookie to SEB's cookieless cookie jar.
    const verified = await auth.api.verifyOneTimeToken({
      body: { token },
      asResponse: true,
    })

    expect(verified.ok).toBe(true)
    expect(verified.headers.get("set-cookie")).toMatch(/session_token=/)
  })

  it.each([
    "/api/auth/one-time-token/verify",
    "/api/auth/one-time-token/verify/",
    "/api/auth/one-time-token/verify?x=1",
    "/api/auth//one-time-token/verify",
    "/api/auth/one-time-token//verify",
    "/api/auth/one-time-token/%76erify",
    "/api/auth/One-Time-Token/Verify",
  ])("does not redeem a live token via POST %s", async (path) => {
    const auth = setup()
    const headers = await signedInHeaders(auth)
    const { token } = await auth.api.generateOneTimeToken({ headers })

    const res = await auth.handler(
      new Request(BASE + path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ token }),
      })
    )

    expect(res.ok).toBe(false)
    expect(res.headers.get("set-cookie")).toBeNull()
    // The token was not consumed either: the real handoff still works.
    await expect(
      auth.api.verifyOneTimeToken({ body: { token } })
    ).resolves.toMatchObject({ user: { email: "student@example.com" } })
  })

  it("does not mint tokens via GET /one-time-token/generate", async () => {
    const auth = setup()
    const headers = await signedInHeaders(auth)

    const res = await auth.handler(
      new Request(BASE + "/api/auth/one-time-token/generate", { headers })
    )

    expect(res.status).toBe(404)
  })
})
