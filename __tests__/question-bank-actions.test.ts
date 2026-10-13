import { describe, expect, it, vi, beforeEach } from "vitest"

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    questionBankItem: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))

const { findDuplicateBankItem, createBankItem } =
  await import("@/lib/question-bank-actions")

const input = {
  type: "SHORT_ANSWER",
  title: "Hauptstadt der Schweiz?",
  points: 1,
  required: true,
  config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 100 },
}

describe("findDuplicateBankItem", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("matches on type, title, points, required, and deep-equal config for the caller only", async () => {
    prismaMock.questionBankItem.findFirst.mockResolvedValue({ id: "item1" })
    const result = await findDuplicateBankItem("teacher1", input)

    expect(result).toEqual({ id: "item1" })
    expect(prismaMock.questionBankItem.findFirst).toHaveBeenCalledWith({
      where: {
        creatorId: "teacher1",
        type: "SHORT_ANSWER",
        title: "Hauptstadt der Schweiz?",
        points: 1,
        required: true,
        config: { equals: input.config },
      },
      select: { id: true },
    })
  })

  it("returns null when the caller has no identical item", async () => {
    prismaMock.questionBankItem.findFirst.mockResolvedValue(null)
    await expect(findDuplicateBankItem("teacher1", input)).resolves.toBeNull()
  })
})

describe("createBankItem", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("creates the item for the caller", async () => {
    prismaMock.questionBankItem.create.mockResolvedValue({ id: "new-item" })
    await createBankItem("teacher1", input, null)

    expect(prismaMock.questionBankItem.create).toHaveBeenCalledWith({
      data: {
        type: "SHORT_ANSWER",
        title: "Hauptstadt der Schweiz?",
        points: 1,
        required: true,
        config: input.config,
        creatorId: "teacher1",
      },
    })
  })

  it("honors a folder when given", async () => {
    prismaMock.questionBankItem.create.mockResolvedValue({ id: "new-item" })
    await createBankItem("teacher1", input, "folder1")

    expect(prismaMock.questionBankItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ folderId: "folder1" }),
    })
  })
})
