import { describe, expect, it } from "vitest"

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db"
const { DEFAULT_TX_MAX_WAIT_MS, transactionMaxWaitMs } =
  await import("@/lib/prisma")

describe("transactionMaxWaitMs", () => {
  it("defaults well above Prisma's own 2 s maxWait", () => {
    expect(transactionMaxWaitMs(undefined)).toBe(DEFAULT_TX_MAX_WAIT_MS)
    expect(DEFAULT_TX_MAX_WAIT_MS).toBeGreaterThan(2000)
  })

  it("treats compose's empty `${DB_TX_MAX_WAIT_MS:-}` as unset", () => {
    expect(transactionMaxWaitMs("")).toBe(DEFAULT_TX_MAX_WAIT_MS)
  })

  it("uses a positive override", () => {
    expect(transactionMaxWaitMs("15000")).toBe(15000)
  })

  it("ignores zero, negative and non-numeric values", () => {
    for (const raw of ["0", "-5", "abc", "Infinity"]) {
      expect(transactionMaxWaitMs(raw)).toBe(DEFAULT_TX_MAX_WAIT_MS)
    }
  })
})
