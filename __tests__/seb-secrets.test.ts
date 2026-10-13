import { beforeEach, describe, expect, it, vi } from "vitest"
import { encryptSecret } from "@/lib/at-rest-encryption"

const findUniqueMock = vi.fn()
const updateManyMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    exam: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
    },
  },
}))

const { ensureSebQuitPassword, ensureSebExamKeySalt } =
  await import("@/lib/seb-secrets")

beforeEach(() => {
  findUniqueMock.mockReset()
  updateManyMock.mockReset()
  updateManyMock.mockResolvedValue({ count: 1 })
})

describe("ensureSebQuitPassword", () => {
  it("returns the decrypted password without writing when an encrypted one exists", async () => {
    findUniqueMock.mockResolvedValue({
      sebQuitPassword: encryptSecret("EXISTING77"),
    })

    await expect(ensureSebQuitPassword("exam1")).resolves.toBe("EXISTING77")
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("re-encrypts a legacy plaintext password in place (best-effort)", async () => {
    findUniqueMock.mockResolvedValue({ sebQuitPassword: "LEGACYPLAIN" })

    await expect(ensureSebQuitPassword("exam1")).resolves.toBe("LEGACYPLAIN")
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "exam1", sebQuitPassword: "LEGACYPLAIN" },
      data: { sebQuitPassword: expect.stringMatching(/^enc:v1:/) },
    })
  })

  it("generates and persists an encrypted password on first use", async () => {
    findUniqueMock
      .mockResolvedValueOnce({ sebQuitPassword: null })
      .mockResolvedValueOnce({ sebQuitPassword: encryptSecret("GENERATED1") })

    await expect(ensureSebQuitPassword("exam1")).resolves.toBe("GENERATED1")
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "exam1", sebQuitPassword: null },
      data: { sebQuitPassword: expect.stringMatching(/^enc:v1:/) },
    })
  })

  it("writes conditionally, so a concurrent caller cannot overwrite a password a .seb file was already built from", async () => {
    findUniqueMock.mockResolvedValueOnce({ sebQuitPassword: null })
    // The other request won the race between our read and our write.
    updateManyMock.mockResolvedValue({ count: 0 })
    findUniqueMock.mockResolvedValueOnce({ sebQuitPassword: "WINNER1234" })

    // We must return the winner's password, not the candidate we generated —
    // otherwise the Config Key we persist would not match the file we hand out.
    await expect(ensureSebQuitPassword("exam1")).resolves.toBe("WINNER1234")
    expect(updateManyMock.mock.calls[0][0].where).toEqual({
      id: "exam1",
      sebQuitPassword: null,
    })
  })

  it("throws rather than returning an unpersisted password if the row vanished", async () => {
    findUniqueMock
      .mockResolvedValueOnce({ sebQuitPassword: null })
      .mockResolvedValueOnce(null)

    await expect(ensureSebQuitPassword("exam1")).rejects.toThrow(
      /could not persist/
    )
  })
})

describe("ensureSebExamKeySalt", () => {
  it("returns the persisted salt without writing when one already exists", async () => {
    const salt = new Uint8Array(32).fill(9)
    findUniqueMock.mockResolvedValue({
      sebExamKeySalt: salt,
      sebConfigKey: null,
    })

    await expect(ensureSebExamKeySalt("exam1")).resolves.toEqual(
      Buffer.from(salt)
    )
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("generates and persists a 32-byte salt on first use", async () => {
    const generated = new Uint8Array(32).fill(4)
    findUniqueMock
      .mockResolvedValueOnce({ sebExamKeySalt: null, sebConfigKey: null })
      .mockResolvedValueOnce({ sebExamKeySalt: generated })

    await expect(ensureSebExamKeySalt("exam1")).resolves.toEqual(
      Buffer.from(generated)
    )
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "exam1", sebExamKeySalt: null, sebConfigKey: null },
      data: { sebExamKeySalt: expect.objectContaining({ length: 32 }) },
    })
  })

  it("refuses to salt an exam whose Config Key is already frozen", async () => {
    // The migration hazard: such an exam's key was computed unsalted and is
    // baked into every .seb file already downloaded. Salting it now would
    // change the key and deny every student holding one.
    findUniqueMock.mockResolvedValue({
      sebExamKeySalt: null,
      sebConfigKey: "abc123",
    })

    await expect(ensureSebExamKeySalt("exam1")).resolves.toBeNull()
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("returns null rather than throwing when the write is lost", async () => {
    // Unlike the quit password this degrades instead of failing: a null salt
    // omits examKeySalt from the .seb file, which is exactly the pre-existing
    // behaviour, so a download still succeeds.
    findUniqueMock
      .mockResolvedValueOnce({ sebExamKeySalt: null, sebConfigKey: null })
      .mockResolvedValueOnce(null)

    await expect(ensureSebExamKeySalt("exam1")).resolves.toBeNull()
  })
})

describe("SEB secrets inside an exam-row transaction", () => {
  it("uses the supplied transaction for quit-password initialization", async () => {
    const tx = {
      exam: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ sebQuitPassword: null })
          .mockResolvedValueOnce({
            sebQuitPassword: encryptSecret("TXPASSWORD"),
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    await expect(ensureSebQuitPassword("exam1", tx as never)).resolves.toBe(
      "TXPASSWORD"
    )
    expect(tx.exam.updateMany).toHaveBeenCalledOnce()
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
  })
  it("uses the supplied transaction for key-salt initialization", async () => {
    const salt = new Uint8Array(32).fill(9)
    const tx = {
      exam: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ sebExamKeySalt: null, sebConfigKey: null })
          .mockResolvedValueOnce({ sebExamKeySalt: salt }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    }
    await expect(ensureSebExamKeySalt("exam1", tx as never)).resolves.toEqual(
      Buffer.from(salt)
    )
    expect(tx.exam.updateMany).toHaveBeenCalledOnce()
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})
