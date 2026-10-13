import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, auditLogMock } = vi.hoisted(() => ({
  prismaMock: {
    questionBankItem: { findUnique: vi.fn(), update: vi.fn() },
    folder: { findFirst: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
  auditLogMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))

const BANK_ID = "c000000000000000000000004"
const FOLDER_ID = "c000000000000000000000003"
const params = Promise.resolve({ id: BANK_ID })

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/question-bank/${BANK_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

const bankItem = {
  id: BANK_ID,
  creatorId: "teacher1",
  type: "SHORT_ANSWER",
  title: "Hauptstadt der Schweiz?",
  points: 1,
  required: true,
  config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 100 },
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({ user: { id: "teacher1", role: "TEACHER" } })
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
  prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
  prismaMock.questionBankItem.update.mockResolvedValue({
    ...bankItem,
    folderId: FOLDER_ID,
  })
  prismaMock.folder.findFirst.mockResolvedValue({ id: FOLDER_ID })
})

describe("PATCH /api/question-bank/[id] — folder assignment", () => {
  it("assigns a folder the caller owns", async () => {
    const { PATCH } = await import("@/app/api/question-bank/[id]/route")
    const res = await PATCH(patchRequest({ folderId: FOLDER_ID }), { params })

    expect(res.status).toBe(200)
    expect(prismaMock.folder.findFirst).toHaveBeenCalledWith({
      where: { id: FOLDER_ID, creatorId: "teacher1" },
      select: { id: true },
    })
    expect(prismaMock.questionBankItem.update).toHaveBeenCalledWith({
      where: { id: BANK_ID },
      data: expect.objectContaining({ folderId: FOLDER_ID }),
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_ITEM_UPDATED",
        entityId: BANK_ID,
      })
    )
  })

  it("rejects a folder the caller does not own", async () => {
    prismaMock.folder.findFirst.mockResolvedValue(null)
    const { PATCH } = await import("@/app/api/question-bank/[id]/route")
    const res = await PATCH(patchRequest({ folderId: FOLDER_ID }), { params })

    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
  })

  it("removes the folder when folderId is null", async () => {
    const { PATCH } = await import("@/app/api/question-bank/[id]/route")
    const res = await PATCH(patchRequest({ folderId: null }), { params })

    expect(res.status).toBe(200)
    expect(prismaMock.folder.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.questionBankItem.update).toHaveBeenCalledWith({
      where: { id: BANK_ID },
      data: expect.objectContaining({ folderId: null }),
    })
  })

  it("rejects an invalid folderId shape", async () => {
    const { PATCH } = await import("@/app/api/question-bank/[id]/route")
    const res = await PATCH(patchRequest({ folderId: "not-a-cuid" }), {
      params,
    })
    expect(res.status).toBe(422)
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
  })

  it("still allows content-only updates without touching the folder", async () => {
    const { PATCH } = await import("@/app/api/question-bank/[id]/route")
    const res = await PATCH(patchRequest({ title: "Neuer Titel", points: 3 }), {
      params,
    })

    expect(res.status).toBe(200)
    expect(prismaMock.questionBankItem.update).toHaveBeenCalledWith({
      where: { id: BANK_ID },
      data: expect.objectContaining({ title: "Neuer Titel", points: 3 }),
    })
    expect(
      prismaMock.questionBankItem.update.mock.calls[0][0].data
    ).not.toHaveProperty("folderId")
  })
})
