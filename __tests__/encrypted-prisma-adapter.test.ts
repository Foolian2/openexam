import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BetterAuthOptions } from "better-auth"

// The fake base adapter mimics better-auth's stock "as-is" transaction:
// `transaction(cb)` hands the callback the raw, UNWRAPPED adapter (see
// @better-auth/core's createAsIsTransaction). That is exactly the path that
// used to let `createOAuthUser` (first OAuth sign-in) write tokens in
// plaintext, bypassing the encryption wrapper.
const state = vi.hoisted(() => {
  const createCalls: Array<{ model: string; data: Record<string, unknown> }> =
    []
  const findOneResult: { row: Record<string, unknown> | null } = { row: null }
  const findManyResult: { rows: Record<string, unknown>[] } = { rows: [] }
  // A tiny in-memory "database" for update/updateMany so the tests can
  // confirm the value that actually lands in storage is ciphertext, not just
  // that the wrapper's return value looks right.
  const rows = new Map<string, Record<string, unknown>>()
  const updateCalls: Array<{ model: string; update: Record<string, unknown> }> =
    []
  const updateManyCalls: Array<{
    model: string
    update: Record<string, unknown>
  }> = []

  // consumeOne/incrementOne are better-auth 1.7's atomic primitives; both
  // return the affected row, so both have to cross the encryption boundary.
  const consumeOneResult: { row: Record<string, unknown> | null } = {
    row: null,
  }
  const incrementOneCalls: Array<{
    model: string
    set?: Record<string, unknown>
  }> = []

  const rawBase: Record<string, unknown> = {
    id: "prisma",
    consumeOne: async () => consumeOneResult.row,
    incrementOne: async (args: {
      model: string
      set?: Record<string, unknown>
    }) => {
      incrementOneCalls.push({ model: args.model, set: args.set })
      return { id: "acc-1", ...args.set }
    },
    create: async (args: { model: string; data: Record<string, unknown> }) => {
      createCalls.push({ model: args.model, data: args.data })
      return { id: "acc-1", ...args.data }
    },
    update: async (args: {
      model: string
      where: Array<{ field: string; value: unknown }>
      update: Record<string, unknown>
    }) => {
      updateCalls.push({ model: args.model, update: args.update })
      const id = args.where.find((w) => w.field === "id")?.value as string
      const existing = rows.get(id) ?? { id }
      const merged = { ...existing, ...args.update }
      rows.set(id, merged)
      return merged
    },
    updateMany: async (args: {
      model: string
      where: Array<{ field: string; value: unknown }>
      update: Record<string, unknown>
    }) => {
      updateManyCalls.push({ model: args.model, update: args.update })
      let count = 0
      for (const [id, existing] of rows) {
        rows.set(id, { ...existing, ...args.update })
        count++
      }
      return count
    },
    findOne: async () => findOneResult.row,
    findMany: async () => findManyResult.rows,
    delete: async () => undefined,
    deleteMany: async () => 0,
    count: async () => 0,
  }
  rawBase.transaction = (cb: (trx: unknown) => Promise<unknown>) =>
    cb(rawBase)

  return {
    consumeOneResult,
    incrementOneCalls,
    createCalls,
    findOneResult,
    findManyResult,
    rows,
    updateCalls,
    updateManyCalls,
    rawBase,
  }
})

vi.mock("better-auth/adapters/prisma", () => ({
  prismaAdapter: () => () => state.rawBase,
}))

const { encryptedPrismaAdapter } = await import(
  "@/lib/encrypted-prisma-adapter"
)
const { decryptSecret } = await import("@/lib/at-rest-encryption")

function buildAdapter() {
  const factory = encryptedPrismaAdapter(
    {} as never,
    { provider: "postgresql" } as never
  )
  return factory({} as BetterAuthOptions)
}

describe("encryptedPrismaAdapter", () => {
  beforeEach(() => {
    state.rows.clear()
    state.updateCalls.length = 0
    state.updateManyCalls.length = 0
    state.findManyResult.rows = []
    state.consumeOneResult.row = null
    state.incrementOneCalls.length = 0
  })

  it("encrypts account tokens on a direct create", async () => {
    state.createCalls.length = 0
    const adapter = buildAdapter()

    await adapter.create({
      model: "account",
      data: { accessToken: "plain-access", refreshToken: "plain-refresh" },
    })

    expect(state.createCalls).toHaveLength(1)
    const written = state.createCalls[0].data
    expect(written.accessToken).toMatch(/^enc:v1:/)
    expect(written.refreshToken).toMatch(/^enc:v1:/)
    expect(decryptSecret(written.accessToken as string)).toBe("plain-access")
  })

  it("leaves non-account models untouched", async () => {
    state.createCalls.length = 0
    const adapter = buildAdapter()

    await adapter.create({
      model: "session",
      data: { token: "session-token" },
    })

    expect(state.createCalls[0].data.token).toBe("session-token")
  })

  // The regression this file exists for: better-auth runs createOAuthUser
  // (first sign-in of a new OAuth user) inside adapter.transaction, and the
  // stock as-is transaction passes the callback the unwrapped base adapter.
  // The wrapper must re-wrap that transaction adapter or the tokens land in
  // the database in plaintext.
  it("encrypts account tokens created inside a transaction", async () => {
    state.createCalls.length = 0
    const adapter = buildAdapter()

    await adapter.transaction?.(async (trx) => {
      await trx.create({
        model: "account",
        data: {
          accessToken: "tx-access",
          refreshToken: "tx-refresh",
          idToken: "tx-id",
        },
      })
      return null
    })

    expect(state.createCalls).toHaveLength(1)
    const written = state.createCalls[0].data
    expect(written.accessToken).toMatch(/^enc:v1:/)
    expect(written.refreshToken).toMatch(/^enc:v1:/)
    expect(written.idToken).toMatch(/^enc:v1:/)
    expect(decryptSecret(written.refreshToken as string)).toBe("tx-refresh")
  })

  it("decrypts account tokens on findOne, incl. inside a transaction", async () => {
    const adapter = buildAdapter()
    const { encryptSecret } = await import("@/lib/at-rest-encryption")
    state.findOneResult.row = {
      id: "acc-1",
      accessToken: encryptSecret("stored-access"),
    }

    const direct = await adapter.findOne<{ accessToken: string }>({
      model: "account",
      where: [{ field: "id", value: "acc-1" }],
    })
    expect(direct?.accessToken).toBe("stored-access")

    const inTx = await adapter.transaction?.(async (trx) => {
      return trx.findOne<{ accessToken: string }>({
        model: "account",
        where: [{ field: "id", value: "acc-1" }],
      })
    })
    expect(inTx?.accessToken).toBe("stored-access")
  })

  // better-auth's OAuth token refresh goes through adapter.update, not
  // create — if the wrapper only encrypted on create, a refreshed token
  // would land in the database as plaintext.
  it("encrypts account tokens written through update, and decrypts what's read back", async () => {
    const adapter = buildAdapter()

    const result = await adapter.update<{ accessToken: string }>({
      model: "account",
      where: [{ field: "id", value: "acc-1" }],
      update: { accessToken: "refreshed-access" },
    })

    expect(state.updateCalls).toHaveLength(1)
    // Confirm the value that actually lands in the mock DB layer is
    // ciphertext, not just that the wrapper's return value looks encrypted.
    const storedRow = state.rows.get("acc-1")
    expect(storedRow?.accessToken).toMatch(/^enc:v1:/)
    expect(storedRow?.accessToken).not.toBe("refreshed-access")
    expect(
      decryptSecret(storedRow?.accessToken as string)
    ).toBe("refreshed-access")

    // update() returns whatever the base adapter's update() resolves to
    // (ciphertext here, since this fake mimics Prisma returning the row as
    // stored) — the wrapper does not decrypt update's return value, only
    // findOne/findMany reads.
    expect(result?.accessToken).toMatch(/^enc:v1:/)
  })

  it("leaves update on non-account models untouched", async () => {
    const adapter = buildAdapter()

    await adapter.update({
      model: "session",
      where: [{ field: "id", value: "sess-1" }],
      update: { token: "session-token" },
    })

    expect(state.updateCalls).toHaveLength(1)
    expect(state.rows.get("sess-1")?.token).toBe("session-token")
  })

  it("encrypts account tokens written through updateMany", async () => {
    const adapter = buildAdapter()
    state.rows.set("acc-1", { id: "acc-1" })
    state.rows.set("acc-2", { id: "acc-2" })

    const count = await adapter.updateMany({
      model: "account",
      where: [{ field: "id", value: ["acc-1", "acc-2"] }],
      update: { refreshToken: "bulk-refresh" },
    })

    expect(count).toBe(2)
    expect(state.updateManyCalls).toHaveLength(1)
    for (const id of ["acc-1", "acc-2"]) {
      const stored = state.rows.get(id)
      expect(stored?.refreshToken).toMatch(/^enc:v1:/)
      expect(decryptSecret(stored?.refreshToken as string)).toBe(
        "bulk-refresh"
      )
    }
  })

  it("leaves updateMany on non-account models untouched", async () => {
    const adapter = buildAdapter()
    state.rows.set("sess-1", { id: "sess-1" })

    await adapter.updateMany({
      model: "session",
      where: [{ field: "id", value: "sess-1" }],
      update: { token: "plain-session-token" },
    })

    expect(state.rows.get("sess-1")?.token).toBe("plain-session-token")
  })

  it("decrypts account tokens on findMany", async () => {
    const adapter = buildAdapter()
    const { encryptSecret } = await import("@/lib/at-rest-encryption")
    state.findManyResult.rows = [
      { id: "acc-1", accessToken: encryptSecret("stored-1") },
      { id: "acc-2", accessToken: encryptSecret("stored-2") },
    ]

    const results = await adapter.findMany<{
      id: string
      accessToken: string
    }>({ model: "account" })

    expect(results).toHaveLength(2)
    expect(results[0].accessToken).toBe("stored-1")
    expect(results[1].accessToken).toBe("stored-2")
  })

  it("decrypts account tokens returned by consumeOne", async () => {
    const adapter = buildAdapter()
    const { encryptSecret } = await import("@/lib/at-rest-encryption")
    state.consumeOneResult.row = {
      id: "acc-1",
      refreshToken: encryptSecret("stored-refresh"),
    }

    const row = await adapter.consumeOne<{ refreshToken: string }>({
      model: "account",
      where: [{ field: "id", value: "acc-1" }],
    })

    expect(row?.refreshToken).toBe("stored-refresh")
  })

  it("encrypts the account tokens incrementOne sets, and decrypts what it returns", async () => {
    const adapter = buildAdapter()

    const row = await adapter.incrementOne<{ accessToken: string }>({
      model: "account",
      where: [{ field: "id", value: "acc-1" }],
      increment: { failedAttempts: 1 },
      set: { accessToken: "fresh-token" },
    })

    const written = state.incrementOneCalls[0].set?.accessToken as string
    expect(written).not.toBe("fresh-token")
    expect(decryptSecret(written)).toBe("fresh-token")
    expect(row?.accessToken).toBe("fresh-token")
  })

  it("leaves findMany results for non-account models untouched", async () => {
    const adapter = buildAdapter()
    state.findManyResult.rows = [{ id: "sess-1", token: "plain-token" }]

    const results = await adapter.findMany<{ id: string; token: string }>({
      model: "session",
    })

    expect(results[0].token).toBe("plain-token")
  })
})
