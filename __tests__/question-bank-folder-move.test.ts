import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, auditLogMock } = vi.hoisted(() => ({
  prismaMock: {
    questionBankItem: { findUnique: vi.fn(), update: vi.fn() },
    folder: { findUnique: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
  auditLogMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))

const BANK_ID = "c000000000000000000000004"
const FOLDER_ID = "c000000000000000000000007"
const params = Promise.resolve({ id: BANK_ID })

const bankItem = { id: BANK_ID, creatorId: "teacher1" }

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/question-bank/bank1/folder",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
  prismaMock.questionBankItem.update.mockResolvedValue({
    ...bankItem,
    folderId: FOLDER_ID,
  })
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
})

describe("PATCH /api/question-bank/[id]/folder", () => {
  it("rejects items the caller does not own", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      ...bankItem,
      creatorId: "teacher2",
    })
    const { PATCH } =
      await import("@/app/api/question-bank/[id]/folder/route")
    const res = await PATCH(request({ folderId: FOLDER_ID }), { params })
    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
  })

  it("rejects a folder the caller does not own", async () => {
    prismaMock.folder.findUnique.mockResolvedValue({
      id: FOLDER_ID,
      creatorId: "teacher2",
    })
    const { PATCH } =
      await import("@/app/api/question-bank/[id]/folder/route")
    const res = await PATCH(request({ folderId: FOLDER_ID }), { params })
    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
  })

  it("moves the item when the caller owns both item and folder", async () => {
    prismaMock.folder.findUnique.mockResolvedValue({
      id: FOLDER_ID,
      creatorId: "teacher1",
    })
    const { PATCH } =
      await import("@/app/api/question-bank/[id]/folder/route")
    const res = await PATCH(request({ folderId: FOLDER_ID }), { params })
    expect(res.status).toBe(200)
    expect(prismaMock.questionBankItem.update).toHaveBeenCalledWith({
      where: { id: BANK_ID },
      data: { folderId: FOLDER_ID },
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_ITEM_MOVED_TO_FOLDER",
        entityId: BANK_ID,
      })
    )
  })

  it("unfolds the item when folderId is null", async () => {
    const { PATCH } =
      await import("@/app/api/question-bank/[id]/folder/route")
    const res = await PATCH(request({ folderId: null }), { params })
    expect(res.status).toBe(200)
    expect(prismaMock.folder.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.questionBankItem.update).toHaveBeenCalledWith({
      where: { id: BANK_ID },
      data: { folderId: null },
    })
  })

  it("rejects malformed bodies", async () => {
    const { PATCH } =
      await import("@/app/api/question-bank/[id]/folder/route")
    const res = await PATCH(request({ folderId: 42 }), { params })
    expect(res.status).toBe(422)
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
  })
})
