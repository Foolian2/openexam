import { beforeEach, describe, expect, it, vi } from "vitest"

const { redisMock, logErrorMock } = vi.hoisted(() => ({
  redisMock: { del: vi.fn() },
  logErrorMock: vi.fn(),
}))

vi.mock("@/lib/redis", () => ({ redis: redisMock }))
vi.mock("@/lib/logger", () => ({ logError: logErrorMock }))

import {
  purgeSessionRedisKeys,
  revokeUserSessionsInTx,
} from "@/lib/session-revocation"
import type { Prisma } from "@/generated/prisma/client"

beforeEach(() => {
  vi.resetAllMocks()
})

describe("revokeUserSessionsInTx", () => {
  it("reads and deletes the user's sessions through the transaction client", async () => {
    const tx = {
      session: {
        findMany: vi.fn().mockResolvedValue([{ token: "t1" }, { token: "t2" }]),
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    }

    const tokens = await revokeUserSessionsInTx(
      tx as unknown as Prisma.TransactionClient,
      "user1"
    )

    expect(tokens).toEqual(["t1", "t2"])
    expect(tx.session.findMany).toHaveBeenCalledWith({
      where: { userId: "user1" },
      select: { token: true },
    })
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user1" },
    })
    // Read before delete, or the tokens to purge would already be gone.
    expect(tx.session.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.session.deleteMany.mock.invocationCallOrder[0]
    )
  })

  it("returns no tokens when the user has no sessions", async () => {
    const tx = {
      session: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    }
    expect(
      await revokeUserSessionsInTx(
        tx as unknown as Prisma.TransactionClient,
        "user1"
      )
    ).toEqual([])
  })
})

describe("purgeSessionRedisKeys", () => {
  it("does nothing for an empty token list", async () => {
    expect(await purgeSessionRedisKeys([])).toBe(0)
    expect(redisMock.del).not.toHaveBeenCalled()
  })

  it("deletes every token once when Redis succeeds", async () => {
    redisMock.del.mockResolvedValue(1)

    expect(await purgeSessionRedisKeys(["t1", "t2"])).toBe(0)
    expect(redisMock.del).toHaveBeenCalledTimes(2)
    expect(redisMock.del).toHaveBeenCalledWith("t1")
    expect(redisMock.del).toHaveBeenCalledWith("t2")
    expect(logErrorMock).not.toHaveBeenCalled()
  })

  it("retries after a transient failure and stays quiet when the retry works", async () => {
    redisMock.del
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue(1)

    expect(await purgeSessionRedisKeys(["t1", "t2"])).toBe(0)
    // Two on the first attempt, two on the retry.
    expect(redisMock.del).toHaveBeenCalledTimes(4)
    expect(logErrorMock).not.toHaveBeenCalled()
  })

  it("reports the snapshots that survive both attempts", async () => {
    redisMock.del.mockImplementation(async (token: string) => {
      if (token === "t2") throw new Error("down")
      return 1
    })

    expect(await purgeSessionRedisKeys(["t1", "t2", "t3"])).toBe(1)
    expect(redisMock.del).toHaveBeenCalledTimes(6)
    expect(logErrorMock).toHaveBeenCalledTimes(1)
    expect(logErrorMock.mock.calls[0][1]).toEqual({ failed: 1, total: 3 })
  })
})
