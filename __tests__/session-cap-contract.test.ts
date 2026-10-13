import { describe, expect, it } from "vitest"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import {
  clampSessionSnapshot,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
  sessionCreatedAtFromHookContext,
} from "@/lib/session-cap"

// Pins lib/session-cap.ts against what the installed better-auth actually
// does, not against hand-written fixtures: the snapshot it writes to
// secondary storage and the context it hands the session.update.before hook.
// If an upgrade changes either, these fail instead of the cap going quiet.

const DAY = 24 * 60 * 60 * 1000

function setup() {
  const store = new Map<string, string>()
  const hookCreatedAts: unknown[] = []
  const auth = betterAuth({
    secret: "session-cap-contract-test-secret-0123456789",
    baseURL: "http://localhost:3000",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    secondaryStorage: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value)
      },
      delete: async (key) => {
        store.delete(key)
      },
      getAndDelete: async (key) => {
        const value = store.get(key) ?? null
        store.delete(key)
        return value
      },
      increment: async (key) => {
        const next = Number(store.get(key) ?? 0) + 1
        store.set(key, String(next))
        return next
      },
    },
    emailAndPassword: { enabled: true },
    // updateAge 0: every getSession is due for a sliding refresh.
    session: { updateAge: 0 },
    databaseHooks: {
      session: {
        update: {
          before: async (_data, context) => {
            hookCreatedAts.push(sessionCreatedAtFromHookContext(context))
          },
        },
      },
    },
  })
  return { auth, store, hookCreatedAts }
}

async function signUp(auth: ReturnType<typeof setup>["auth"]) {
  const res = await auth.api.signUpEmail({
    body: {
      email: "contract@example.com",
      password: "correct-horse-battery",
      name: "Contract",
    },
    returnHeaders: true,
  })
  const cookie = res.headers.get("set-cookie")!.split(";")[0]
  return { token: res.response.token!, cookie }
}

describe("session cap against real better-auth", () => {
  it("recognizes the session snapshot better-auth writes", async () => {
    const { auth, store } = setup()
    const { token } = await signUp(auth)
    const raw = store.get(token)
    expect(raw).toBeDefined()

    // A fresh snapshot is within the cap and must pass through untouched.
    expect(clampSessionSnapshot(raw!)).toBe(raw)

    // Backdate it past the cap: the clamp must expire it.
    const snapshot = JSON.parse(raw!)
    const createdAt = new Date(Date.now() - 31 * DAY)
    snapshot.session.createdAt = createdAt.toISOString()
    const clamped = JSON.parse(clampSessionSnapshot(JSON.stringify(snapshot))!)
    expect(new Date(clamped.session.expiresAt).getTime()).toBe(
      createdAt.getTime() + SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000
    )
  })

  it("hands the refreshed session's createdAt to session.update.before", async () => {
    const { auth, hookCreatedAts } = setup()
    const { cookie } = await signUp(auth)
    await auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(hookCreatedAts.length).toBeGreaterThan(0)
    for (const createdAt of hookCreatedAts) {
      expect(createdAt).toBeDefined()
      expect(Number.isNaN(new Date(createdAt as string).getTime())).toBe(false)
    }
  })
})
