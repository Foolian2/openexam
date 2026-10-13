import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock, auditLogMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn(), findFirst: vi.fn() },
    question: { findFirst: vi.fn() },
    folder: { findFirst: vi.fn() },
    questionBankItem: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      createManyAndReturn: vi.fn(),
    },
  },
  authMock: { api: { getSession: vi.fn() } },
  auditLogMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
  })
}

const validShortAnswer = {
  type: "SHORT_ANSWER",
  title: "Hauptstadt der Schweiz?",
  points: 1,
  required: true,
  config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 100 },
}

// Route schemas validate with z.string().cuid(), so test IDs must look like
// real cuids ("c" + at least 8 non-space, non-dash chars).
const EXAM_ID = "c000000000000000000000001"
const QUESTION_ID = "c000000000000000000000002"
const FOLDER_ID = "c000000000000000000000003"
const BANK_ID = "c000000000000000000000004"

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({ user: { id: "teacher1", role: "TEACHER" } })
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
})

describe("POST /api/question-bank/from-question (save-to-bank)", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { POST } = await import("@/app/api/question-bank/from-question/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/from-question", {})
    )
    expect(res.status).toBe(401)
  })

  it("rejects saving a question from an exam the caller does not own", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      creatorId: "teacher2",
    })
    const { POST } = await import("@/app/api/question-bank/from-question/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/from-question", {
        examId: EXAM_ID,
        questionId: QUESTION_ID,
      })
    )
    expect(res.status).toBe(404)
  })

  it("rejects a question that does not belong to the exam", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      creatorId: "teacher1",
    })
    prismaMock.question.findFirst.mockResolvedValue(null)
    const { POST } = await import("@/app/api/question-bank/from-question/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/from-question", {
        examId: EXAM_ID,
        questionId: QUESTION_ID,
      })
    )
    expect(res.status).toBe(404)
    expect(prismaMock.question.findFirst).toHaveBeenCalledWith({
      where: { id: QUESTION_ID, examId: EXAM_ID },
    })
  })

  it("returns the existing item instead of duplicating when identical", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      creatorId: "teacher1",
    })
    prismaMock.question.findFirst.mockResolvedValue({
      ...validShortAnswer,
      examId: EXAM_ID,
    })
    prismaMock.questionBankItem.findFirst.mockResolvedValue({ id: "existing" })

    const { POST } = await import("@/app/api/question-bank/from-question/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/from-question", {
        examId: EXAM_ID,
        questionId: QUESTION_ID,
      })
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ item: { id: "existing" }, deduplicated: true })
    expect(prismaMock.questionBankItem.create).not.toHaveBeenCalled()
    expect(auditLogMock.createAuditLog).not.toHaveBeenCalled()
  })

  it("creates a new bank item and audit-logs it exam-scoped", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      creatorId: "teacher1",
    })
    prismaMock.question.findFirst.mockResolvedValue({
      ...validShortAnswer,
      examId: EXAM_ID,
    })
    prismaMock.questionBankItem.findFirst.mockResolvedValue(null)
    prismaMock.questionBankItem.create.mockResolvedValue({ id: BANK_ID })

    const { POST } = await import("@/app/api/question-bank/from-question/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/from-question", {
        examId: EXAM_ID,
        questionId: QUESTION_ID,
      })
    )

    expect(res.status).toBe(201)
    expect(prismaMock.questionBankItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "Hauptstadt der Schweiz?",
        creatorId: "teacher1",
      }),
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_SAVED_TO_BANK",
        examId: EXAM_ID,
        metadata: { source: "exam", questionId: QUESTION_ID, examId: EXAM_ID },
      })
    )
  })

  it("rejects a folder the caller does not own", async () => {
    prismaMock.exam.findUnique.mockResolvedValue({
      id: EXAM_ID,
      creatorId: "teacher1",
    })
    prismaMock.question.findFirst.mockResolvedValue({
      ...validShortAnswer,
      examId: EXAM_ID,
    })
    prismaMock.folder.findFirst.mockResolvedValue(null)

    const { POST } = await import("@/app/api/question-bank/from-question/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/from-question", {
        examId: EXAM_ID,
        questionId: QUESTION_ID,
        folderId: FOLDER_ID,
      })
    )
    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.create).not.toHaveBeenCalled()
  })
})

describe("POST /api/question-bank/[id]/duplicate", () => {
  const params = Promise.resolve({ id: BANK_ID })

  it("rejects items the caller does not own", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher2",
    })
    const { POST } =
      await import("@/app/api/question-bank/[id]/duplicate/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/bank1/duplicate", {}),
      { params }
    )
    expect(res.status).toBe(404)
  })

  it("creates an independent copy with a (Kopie) suffix and inherits the folder", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher1",
      type: "TRUE_FALSE",
      title: "Bern liegt in der Schweiz",
      points: 2,
      required: true,
      config: { isCorrect: true },
      folderId: FOLDER_ID,
    })
    prismaMock.questionBankItem.create.mockResolvedValue({ id: "copy1" })

    const { POST } =
      await import("@/app/api/question-bank/[id]/duplicate/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/bank1/duplicate", {}),
      { params }
    )

    expect(res.status).toBe(201)
    expect(prismaMock.questionBankItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        title: "Bern liegt in der Schweiz (Kopie)",
        creatorId: "teacher1",
        folderId: FOLDER_ID,
      }),
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_ITEM_DUPLICATED",
        entityId: "copy1",
        metadata: { sourceItemId: BANK_ID },
      })
    )
  })
})

describe("POST/DELETE /api/question-bank/[id]/share", () => {
  const params = Promise.resolve({ id: BANK_ID })

  it("rejects a POST (generate share link) on an item the caller does not own", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher2",
      shareToken: null,
    })
    const { POST } = await import("@/app/api/question-bank/[id]/share/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/bank1/share", {}),
      { params }
    )
    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.updateMany).not.toHaveBeenCalled()
  })

  it("rejects a DELETE (revoke share link) on an item the caller does not own", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher2",
      shareToken: "existing",
    })
    const { DELETE } = await import("@/app/api/question-bank/[id]/share/route")
    const res = await DELETE(
      new NextRequest("http://localhost/api/question-bank/bank1/share", {
        method: "DELETE",
        headers: { origin: "http://localhost:3000" },
      }),
      { params }
    )
    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
  })

  it("generates a token on first share and audit-logs it", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher1",
      shareToken: null,
    })
    prismaMock.questionBankItem.updateMany.mockResolvedValue({ count: 1 })

    const { POST } = await import("@/app/api/question-bank/[id]/share/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/bank1/share", {}),
      { params }
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.shareToken).toMatch(/^[0-9a-f]{32}$/)
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_SHARED",
        entityId: BANK_ID,
      })
    )
  })

  it("is idempotent: returns the existing token without re-rolling it", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher1",
      shareToken: "existing",
    })

    const { POST } = await import("@/app/api/question-bank/[id]/share/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/bank1/share", {}),
      { params }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ shareToken: "existing" })
    expect(prismaMock.questionBankItem.update).not.toHaveBeenCalled()
    expect(auditLogMock.createAuditLog).not.toHaveBeenCalled()
  })

  it("revokes sharing on DELETE", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      id: BANK_ID,
      creatorId: "teacher1",
      shareToken: "existing",
    })
    prismaMock.questionBankItem.update.mockResolvedValue({
      id: BANK_ID,
      shareToken: null,
    })

    const { DELETE } = await import("@/app/api/question-bank/[id]/share/route")
    const res = await DELETE(
      new NextRequest("http://localhost/api/question-bank/bank1/share", {
        method: "DELETE",
        headers: { origin: "http://localhost:3000" },
      }),
      { params }
    )

    expect(res.status).toBe(204)
    expect(prismaMock.questionBankItem.update).toHaveBeenCalledWith({
      where: { id: BANK_ID },
      data: { shareToken: null },
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_SHARE_REVOKED",
        entityId: BANK_ID,
      })
    )
  })
})

describe("GET/DELETE /api/question-bank/[id]", () => {
  const params = Promise.resolve({ id: BANK_ID })
  const bankItem = {
    id: BANK_ID,
    creatorId: "teacher1",
    type: "SHORT_ANSWER",
    title: "Hauptstadt der Schweiz?",
    points: 1,
    required: true,
    config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 100 },
  }

  function getRequest(): NextRequest {
    return new NextRequest(`http://localhost/api/question-bank/${BANK_ID}`)
  }

  function deleteRequest(): NextRequest {
    return new NextRequest(`http://localhost/api/question-bank/${BANK_ID}`, {
      method: "DELETE",
    })
  }

  it("rejects an unauthenticated GET", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { GET } = await import("@/app/api/question-bank/[id]/route")
    const res = await GET(getRequest(), { params })
    expect(res.status).toBe(401)
    expect(prismaMock.questionBankItem.findUnique).not.toHaveBeenCalled()
  })

  it("rejects an unauthenticated DELETE", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { DELETE } = await import("@/app/api/question-bank/[id]/route")
    const res = await DELETE(deleteRequest(), { params })
    expect(res.status).toBe(401)
    expect(prismaMock.questionBankItem.findUnique).not.toHaveBeenCalled()
  })

  it("lets the owner GET their own item", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
    const { GET } = await import("@/app/api/question-bank/[id]/route")
    const res = await GET(getRequest(), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ item: bankItem })
  })

  it("rejects a GET for an item owned by a different teacher", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      ...bankItem,
      creatorId: "teacher2",
    })
    const { GET } = await import("@/app/api/question-bank/[id]/route")
    const res = await GET(getRequest(), { params })
    expect(res.status).toBe(404)
  })

  it("lets the owner DELETE their own item and audit-logs it", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(bankItem)
    prismaMock.questionBankItem.delete.mockResolvedValue(bankItem)
    const { DELETE } = await import("@/app/api/question-bank/[id]/route")
    const res = await DELETE(deleteRequest(), { params })
    expect(res.status).toBe(204)
    expect(prismaMock.questionBankItem.delete).toHaveBeenCalledWith({
      where: { id: BANK_ID },
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_ITEM_DELETED",
        entityId: BANK_ID,
      })
    )
  })

  it("rejects a DELETE for an item owned by a different teacher", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      ...bankItem,
      creatorId: "teacher2",
    })
    const { DELETE } = await import("@/app/api/question-bank/[id]/route")
    const res = await DELETE(deleteRequest(), { params })
    expect(res.status).toBe(404)
    expect(prismaMock.questionBankItem.delete).not.toHaveBeenCalled()
  })
})

describe("GET /api/question-bank (list)", () => {
  // Two teachers' items in the same mocked table, to catch a where-clause
  // regression that would leak one teacher's bank into another's list.
  const allItems = [
    { id: "b1", creatorId: "teacher1", title: "Mine" },
    { id: "b2", creatorId: "teacher2", title: "Not mine" },
  ]

  function scoped<T extends { creatorId: string }>(
    where: { creatorId: string },
    rows: T[]
  ) {
    return rows.filter((r) => r.creatorId === where.creatorId)
  }

  it("only returns items owned by the authenticated caller, never another teacher's", async () => {
    prismaMock.questionBankItem.findMany.mockImplementation(
      async ({ where }: { where: { creatorId: string } }) =>
        scoped(where, allItems)
    )
    prismaMock.questionBankItem.count.mockImplementation(
      async ({ where }: { where: { creatorId: string } }) =>
        scoped(where, allItems).length
    )

    const { GET } = await import("@/app/api/question-bank/route")
    const res = await GET(new NextRequest("http://localhost/api/question-bank"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([allItems[0]])
    expect(body.total).toBe(1)
    expect(
      body.items.some((i: { creatorId: string }) => i.creatorId === "teacher2")
    ).toBe(false)
  })

  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { GET } = await import("@/app/api/question-bank/route")
    const res = await GET(new NextRequest("http://localhost/api/question-bank"))
    expect(res.status).toBe(401)
    expect(prismaMock.questionBankItem.findMany).not.toHaveBeenCalled()
  })
})

describe("GET/POST /api/question-bank/shared/[token]", () => {
  const params = Promise.resolve({ token: "abc123" })
  const sharedItem = {
    id: BANK_ID,
    creatorId: "teacher2",
    type: "SHORT_ANSWER",
    title: "Hauptstadt der Schweiz?",
    points: 1,
    required: true,
    config: { acceptedAnswers: ["Bern"], caseSensitive: false, maxLength: 100 },
  }

  it("rejects an unauthenticated GET", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { GET } = await import("@/app/api/question-bank/shared/[token]/route")
    const res = await GET(
      new NextRequest("http://localhost/api/question-bank/shared/abc123"),
      { params }
    )
    expect(res.status).toBe(401)
    expect(prismaMock.questionBankItem.findUnique).not.toHaveBeenCalled()
  })

  it("rejects an unauthenticated POST", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    const { POST } =
      await import("@/app/api/question-bank/shared/[token]/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/shared/abc123", {}),
      { params }
    )
    expect(res.status).toBe(401)
    expect(prismaMock.questionBankItem.findUnique).not.toHaveBeenCalled()
  })

  it("returns a 404 for an unknown token", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(null)
    const { GET } = await import("@/app/api/question-bank/shared/[token]/route")
    const res = await GET(
      new NextRequest("http://localhost/api/question-bank/shared/abc123"),
      { params }
    )
    expect(res.status).toBe(404)
  })

  it("returns the item for a valid token", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      ...sharedItem,
      creator: { name: "Lea" },
    })
    const { GET } = await import("@/app/api/question-bank/shared/[token]/route")
    const res = await GET(
      new NextRequest("http://localhost/api/question-bank/shared/abc123"),
      { params }
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.item).toMatchObject({
      id: BANK_ID,
      title: "Hauptstadt der Schweiz?",
    })
  })

  it("refuses to copy the caller's own item", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue({
      ...sharedItem,
      creatorId: "teacher1",
    })
    const { POST } =
      await import("@/app/api/question-bank/shared/[token]/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/shared/abc123", {}),
      { params }
    )
    expect(res.status).toBe(409)
  })

  it("copies a shared item into the caller's bank and audit-logs the source", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(sharedItem)
    prismaMock.questionBankItem.findFirst.mockResolvedValue(null)
    prismaMock.questionBankItem.create.mockResolvedValue({ id: "copy1" })

    const { POST } =
      await import("@/app/api/question-bank/shared/[token]/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/shared/abc123", {}),
      { params }
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ item: { id: "copy1" }, deduplicated: false })
    expect(prismaMock.questionBankItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creatorId: "teacher1",
        title: "Hauptstadt der Schweiz?",
      }),
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_ITEM_CREATED",
        metadata: { source: "shared", sourceItemId: BANK_ID },
      })
    )
  })

  it("dedupes: returns the caller's existing identical item", async () => {
    prismaMock.questionBankItem.findUnique.mockResolvedValue(sharedItem)
    prismaMock.questionBankItem.findFirst.mockResolvedValue({ id: "existing" })

    const { POST } =
      await import("@/app/api/question-bank/shared/[token]/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/shared/abc123", {}),
      { params }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      item: { id: "existing" },
      deduplicated: true,
    })
    expect(prismaMock.questionBankItem.create).not.toHaveBeenCalled()
  })
})

describe("POST /api/question-bank/import", () => {
  it("creates valid items in one batch and audit-logs counts", async () => {
    prismaMock.questionBankItem.createManyAndReturn.mockResolvedValue([
      { id: "i1" },
      { id: "i2" },
    ])

    const { POST } = await import("@/app/api/question-bank/import/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/import", {
        items: [
          validShortAnswer,
          { ...validShortAnswer, title: "Zweite Frage" },
        ],
      })
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toEqual({ created: 2, failed: [] })
    expect(
      prismaMock.questionBankItem.createManyAndReturn
    ).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ creatorId: "teacher1" }),
      ]),
    })
    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "QUESTION_BANK_IMPORT",
        metadata: { total: 2, created: 2, failed: 0 },
      })
    )
  })

  it("reports invalid items per index and still creates the valid ones", async () => {
    prismaMock.questionBankItem.createManyAndReturn.mockResolvedValue([
      { id: "i1" },
    ])

    const { POST } = await import("@/app/api/question-bank/import/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/import", {
        items: [
          validShortAnswer,
          { ...validShortAnswer, points: -1 },
          { type: "MATCHING", title: "", config: {}, points: 1 },
        ],
      })
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.created).toBe(1)
    expect(body.failed).toHaveLength(2)
    expect(body.failed.map((f: { index: number }) => f.index)).toEqual([1, 2])
    expect(
      prismaMock.questionBankItem.createManyAndReturn
    ).toHaveBeenCalledWith({
      data: [
        {
          type: "SHORT_ANSWER",
          title: "Hauptstadt der Schweiz?",
          points: 1,
          required: true,
          config: validShortAnswer.config,
          creatorId: "teacher1",
        },
      ],
    })
  })

  it("returns 422 when every item is invalid", async () => {
    const { POST } = await import("@/app/api/question-bank/import/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/import", {
        items: [{ ...validShortAnswer, points: 0 }],
      })
    )

    expect(res.status).toBe(422)
    expect(
      prismaMock.questionBankItem.createManyAndReturn
    ).not.toHaveBeenCalled()
  })

  it("rejects more than 100 items", async () => {
    const { POST } = await import("@/app/api/question-bank/import/route")
    const res = await POST(
      jsonRequest("http://localhost/api/question-bank/import", {
        items: Array.from({ length: 101 }, () => validShortAnswer),
      })
    )
    expect(res.status).toBe(422)
  })
})
