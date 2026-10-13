import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, staffMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    exam: { findUnique: vi.fn() },
    question: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    questionBankItem: { findUnique: vi.fn() },
  },
  staffMock: { requireStaff: vi.fn() },
  auditMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/api-auth", () => ({ requireStaff: staffMock.requireStaff }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock.createAuditLog }))

const EXAM_ID = "c000000000000000000000102"
const QUESTION_ID = "c000000000000000000000103"
const BANK_ID = "c000000000000000000000104"
const OWNER_ID = "teacher-1"
const question = {
  id: QUESTION_ID,
  examId: EXAM_ID,
  order: 1,
  type: "MULTIPLE_CHOICE",
  title: "Original",
  points: 1,
  required: true,
  config: {
    multiSelect: false,
    options: [{ id: "a", text: "A", isCorrect: true }],
  },
}
const activeTx = {
  $queryRaw: vi
    .fn()
    .mockResolvedValue([{ creatorId: OWNER_ID, status: "ACTIVE" }]),
  exam: {},
  question: {
    aggregate: vi.fn().mockResolvedValue({ _max: { order: 1 } }),
    create: vi.fn().mockResolvedValue(question),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(question),
    update: vi.fn().mockResolvedValue(question),
    delete: vi.fn().mockResolvedValue(question),
  },
  questionBankItem: {},
}

beforeEach(() => {
  vi.resetAllMocks()
  staffMock.requireStaff.mockResolvedValue({ user: { id: OWNER_ID } })
  auditMock.createAuditLog.mockResolvedValue(undefined)
  prismaMock.exam.findUnique.mockResolvedValue({
    id: EXAM_ID,
    creatorId: OWNER_ID,
    status: "PUBLISHED",
  })
  prismaMock.question.aggregate.mockResolvedValue({ _max: { order: 0 } })
  prismaMock.question.create.mockResolvedValue(question)
  prismaMock.question.findMany.mockResolvedValue([question])
  prismaMock.question.findUnique.mockResolvedValue(question)
  prismaMock.question.update.mockResolvedValue(question)
  prismaMock.question.delete.mockResolvedValue(question)
  prismaMock.questionBankItem.findUnique.mockResolvedValue({
    id: BANK_ID,
    creatorId: OWNER_ID,
    type: question.type,
    title: question.title,
    points: question.points,
    required: question.required,
    config: question.config,
  })
  prismaMock.$transaction.mockImplementation(async (operation) =>
    typeof operation === "function"
      ? operation(activeTx)
      : Promise.all(operation)
  )
  activeTx.$queryRaw.mockResolvedValue([
    { creatorId: OWNER_ID, status: "ACTIVE" },
  ])
  activeTx.question.aggregate.mockResolvedValue({ _max: { order: 1 } })
  activeTx.question.create.mockResolvedValue(question)
})

const cases = [
  {
    name: "create",
    run: async () => {
      const { POST } = await import("@/app/api/exams/[id]/questions/route")
      return POST(
        new NextRequest(`http://localhost/api/exams/${EXAM_ID}/questions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: question.type,
            title: "Added",
            points: 2,
            required: true,
            config: {
              multiSelect: false,
              options: [
                { id: "opt-a", text: "Answer A", isCorrect: true },
                { id: "opt-b", text: "Answer B", isCorrect: false },
                { id: "opt-c", text: "Answer C", isCorrect: false },
              ],
            },
          }),
        }),
        { params: Promise.resolve({ id: EXAM_ID }) }
      )
    },
  },
  {
    name: "PATCH",
    run: async () => {
      const { PATCH } =
        await import("@/app/api/exams/[id]/questions/[qId]/route")
      return PATCH(
        new NextRequest(
          `http://localhost/api/exams/${EXAM_ID}/questions/${QUESTION_ID}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "Edited" }),
          }
        ),
        { params: Promise.resolve({ id: EXAM_ID, qId: QUESTION_ID }) }
      )
    },
  },
  {
    name: "DELETE",
    run: async () => {
      const { DELETE } =
        await import("@/app/api/exams/[id]/questions/[qId]/route")
      return DELETE(
        new NextRequest(
          `http://localhost/api/exams/${EXAM_ID}/questions/${QUESTION_ID}`,
          { method: "DELETE" }
        ),
        { params: Promise.resolve({ id: EXAM_ID, qId: QUESTION_ID }) }
      )
    },
  },
  {
    name: "from-bank copy",
    run: async () => {
      const { POST } =
        await import("@/app/api/exams/[id]/questions/from-bank/route")
      return POST(
        new NextRequest(
          `http://localhost/api/exams/${EXAM_ID}/questions/from-bank`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bankItemId: BANK_ID }),
          }
        ),
        { params: Promise.resolve({ id: EXAM_ID }) }
      )
    },
  },
  {
    name: "reorder",
    run: async () => {
      const { PUT } =
        await import("@/app/api/exams/[id]/questions/reorder/route")
      return PUT(
        new NextRequest(
          `http://localhost/api/exams/${EXAM_ID}/questions/reorder`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ questionIds: [QUESTION_ID] }),
          }
        ),
        { params: Promise.resolve({ id: EXAM_ID }) }
      )
    },
  },
]

describe.each(cases)("question $name vs activation", ({ run }) => {
  it("rechecks editability after locking the parent exam and refuses ACTIVE", async () => {
    const response = await run()

    expect(response.status).toBe(409)
    expect(activeTx.$queryRaw).toHaveBeenCalledOnce()
    expect(activeTx.$queryRaw.mock.calls[0][0].text).toContain('"Exam"')
    expect(activeTx.$queryRaw.mock.calls[0][0].text).toContain("FOR UPDATE")
    expect(activeTx.question.create).not.toHaveBeenCalled()
    expect(activeTx.question.update).not.toHaveBeenCalled()
    expect(activeTx.question.delete).not.toHaveBeenCalled()
    expect(auditMock.createAuditLog).not.toHaveBeenCalled()
  })
})

it("allows a question create when the locked exam is still PUBLISHED", async () => {
  activeTx.$queryRaw.mockResolvedValue([
    { creatorId: OWNER_ID, status: "PUBLISHED" },
  ])
  const response = await cases[0].run()

  expect(response.status).toBe(201)
  expect(activeTx.$queryRaw).toHaveBeenCalledOnce()
  expect(activeTx.question.aggregate).toHaveBeenCalledWith({
    where: { examId: EXAM_ID },
    _max: { order: true },
  })
  expect(activeTx.question.create).toHaveBeenCalledOnce()
  expect(auditMock.createAuditLog).toHaveBeenCalledOnce()
})

it("hides an exam whose owner changed before the mutation acquired its lock", async () => {
  activeTx.$queryRaw.mockResolvedValue([
    { creatorId: "another-teacher", status: "PUBLISHED" },
  ])
  const response = await cases[0].run()

  expect(response.status).toBe(404)
  expect(activeTx.$queryRaw).toHaveBeenCalledOnce()
  expect(activeTx.question.create).not.toHaveBeenCalled()
  expect(auditMock.createAuditLog).not.toHaveBeenCalled()
})
