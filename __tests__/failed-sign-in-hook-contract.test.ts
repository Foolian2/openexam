import { expect, it } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { createAuthMiddleware } from "better-auth/api"
import { isInvalidCredentials } from "@/lib/account-rate-limit"

// lib/auth.ts counts failed password sign-ins per IP in an after hook. That
// relies on better-auth handing the hook its 401 INVALID_EMAIL_OR_PASSWORD
// error and the request headers; this pins the contract against the real
// library (in-memory adapter), so an upgrade that changes it fails here.
it("after hook sees the 401 and the client headers", async () => {
  const seen: { inv: boolean; ip: string | null }[] = []
  const auth = betterAuth({
    secret: "x".repeat(40),
    baseURL: "http://localhost:3000",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return
        seen.push({
          inv: isInvalidCredentials(ctx.context.returned),
          ip: ctx.headers?.get("x-forwarded-for") ?? null,
        })
      }),
    },
  })
  await auth.api.signUpEmail({
    body: { email: "a@b.ch", password: "correct-horse-1", name: "A" },
  })
  const mk = (password: string) =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.7",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ email: "a@b.ch", password }),
      })
    )
  await mk("wrong-password")
  await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.7",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ email: "nobody@b.ch", password: "whatever-123" }),
    })
  )
  await mk("correct-horse-1")
  expect(seen).toEqual([
    { inv: true, ip: "203.0.113.7" },
    { inv: true, ip: "203.0.113.7" },
    { inv: false, ip: "203.0.113.7" },
  ])
})
