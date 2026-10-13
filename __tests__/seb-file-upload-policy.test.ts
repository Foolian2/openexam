import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
    exam: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    question: { count: vi.fn(), findMany: vi.fn(), createMany: vi.fn() },
    questionBankItem: { findUnique: vi.fn() },
  },
  staff: vi.fn(),
  audit: vi.fn(),
  publish: vi.fn(),
  computeKey: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }))
vi.mock("@/lib/api-auth", () => ({ requireStaff: mocks.staff }))
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }))
vi.mock("@/lib/redis", () => ({ redis: { publish: mocks.publish } }))
vi.mock("@/lib/seb-issuance", () => ({ computeSebConfigKey: mocks.computeKey }))

const examId = "c000000000000000000000001"
const bankId = "c000000000000000000000002"
const exam = {
  id: examId,
  creatorId: "teacher",
  status: "PUBLISHED",
  sebRequired: false,
  sebConfigKey: null,
  allowSpellCheck: false,
  scheduledStart: null,
  scheduledEnd: null,
}
const upload = {
  type: "FILE_UPLOAD",
  title: "Submit PDF",
  points: 1,
  required: true,
  config: { allowedExtensions: [".pdf"], maxFileSizeMB: 10, instructions: "" },
}
const tx = {
  $queryRaw: vi.fn(),
  exam: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  question: { aggregate: vi.fn(), create: vi.fn(), count: vi.fn() },
  examSession: { count: vi.fn() },
}
const params = { params: Promise.resolve({ id: examId }) }
function request(path: string, body?: unknown, method = "POST") {
  return new NextRequest(`http://localhost/api/exams/${examId}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.staff.mockResolvedValue({ user: { id: "teacher" } })
  mocks.prisma.exam.findUnique.mockResolvedValue(exam)
  mocks.prisma.exam.updateMany.mockResolvedValue({ count: 1 })
  mocks.prisma.$transaction.mockImplementation((callback) => callback(tx))
  mocks.prisma.questionBankItem.findUnique.mockResolvedValue({
    ...upload,
    id: bankId,
    creatorId: "teacher",
  })
  tx.$queryRaw.mockResolvedValue([{ ...exam, sebRequired: true }])
  tx.exam.findUniqueOrThrow.mockResolvedValue({ ...exam, sebRequired: true })
  tx.exam.updateMany.mockResolvedValue({ count: 1 })
  tx.question.aggregate.mockResolvedValue({ _max: { order: 0 } })
  tx.question.create.mockResolvedValue({ ...upload, id: "question" })
  tx.question.count.mockResolvedValue(1)
  tx.examSession.count.mockResolvedValue(0)
  tx.exam.findUnique.mockImplementation((...args) =>
    mocks.prisma.exam.findUnique(...args)
  )
  tx.exam.updateMany.mockImplementation((...args) =>
    mocks.prisma.exam.updateMany(...args)
  )
})

async function expectBlocked(response: Response) {
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual({
    error: { code: "VALIDATION_ERROR", message: SEB_FILE_UPLOAD_MESSAGE },
  })
  expect(mocks.audit).not.toHaveBeenCalled()
}

describe("SEB file upload policy", () => {
  it("rejects creating or duplicating an upload if SEB was enabled after the initial read", async () => {
    const { POST } = await import("@/app/api/exams/[id]/questions/route")
    await expectBlocked(await POST(request("/questions", upload), params))
    expect(tx.question.create).not.toHaveBeenCalled()
  })

  it("rejects importing upload questions from the bank under the parent lock", async () => {
    const { POST } =
      await import("@/app/api/exams/[id]/questions/from-bank/route")
    await expectBlocked(
      await POST(
        request("/questions/from-bank", { bankItemId: bankId }),
        params
      )
    )
    expect(tx.question.create).not.toHaveBeenCalled()
  })

  it("allows uploads in exams without SEB", async () => {
    tx.$queryRaw.mockResolvedValue([exam])
    const { POST } = await import("@/app/api/exams/[id]/questions/route")
    const response = await POST(request("/questions", upload), params)
    expect(response.status).toBe(201)
    expect(tx.question.create).toHaveBeenCalled()
  })

  it("allows other question types in SEB exams", async () => {
    const { POST } = await import("@/app/api/exams/[id]/questions/route")
    const response = await POST(
      request("/questions", {
        ...upload,
        type: "FREE_TEXT",
        config: { richText: false, maxLength: 1000 },
      }),
      params
    )
    expect(response.status).toBe(201)
  })

  it("rejects enabling SEB when an upload question was inserted concurrently", async () => {
    tx.$queryRaw.mockResolvedValue([exam])
    const { PATCH } = await import("@/app/api/exams/[id]/route")
    await expectBlocked(
      await PATCH(request("", { sebRequired: true }, "PATCH"), params)
    )
    expect(mocks.prisma.exam.updateMany).not.toHaveBeenCalled()
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.question.count.mock.invocationCallOrder[0]
    )
  })

  it("allows unrelated edits on a legacy SEB exam that still has uploads", async () => {
    // Autosave resends sebRequired: true with every metadata edit; only the
    // off→on transition is guarded.
    const legacy = { ...exam, sebRequired: true }
    mocks.prisma.exam.findUnique.mockResolvedValue(legacy)
    tx.$queryRaw.mockResolvedValue([legacy])
    const { PATCH } = await import("@/app/api/exams/[id]/route")
    const response = await PATCH(
      request("", { title: "Neuer Titel", sebRequired: true }, "PATCH"),
      params
    )
    expect(response.status).toBe(200)
    expect(tx.question.count).not.toHaveBeenCalled()
    expect(tx.exam.updateMany).toHaveBeenCalled()
  })

  it("allows enabling SEB when there are no upload questions", async () => {
    tx.question.count.mockResolvedValue(0)
    const { PATCH } = await import("@/app/api/exams/[id]/route")
    const response = await PATCH(
      request("", { sebRequired: true }, "PATCH"),
      params
    )
    expect(response.status).toBe(200)
    expect(tx.exam.updateMany).toHaveBeenCalled()
  })

  it("allows importing uploads into an exam without SEB", async () => {
    tx.$queryRaw.mockResolvedValue([exam])
    const { POST } =
      await import("@/app/api/exams/[id]/questions/from-bank/route")
    const response = await POST(
      request("/questions/from-bank", { bankItemId: bankId }),
      params
    )
    expect(response.status).toBe(201)
  })

  it("allows disabling SEB to repair an existing incompatible exam", async () => {
    mocks.prisma.exam.findUnique.mockResolvedValue({
      ...exam,
      sebRequired: true,
    })
    const { PATCH } = await import("@/app/api/exams/[id]/route")
    const response = await PATCH(
      request("", { sebRequired: false }, "PATCH"),
      params
    )
    expect(response.status).toBe(200)
    expect(
      mocks.prisma.exam.updateMany.mock.calls[0][0].where
    ).not.toHaveProperty("questions")
  })

  it("blocks duplicating a legacy SEB exam with upload questions", async () => {
    mocks.prisma.exam.findUnique.mockResolvedValue({
      ...exam,
      sebRequired: true,
    })
    mocks.prisma.question.findMany.mockResolvedValue([upload])
    const { POST } = await import("@/app/api/exams/[id]/duplicate/route")
    await expectBlocked(await POST(request("/duplicate"), params))
    expect(mocks.prisma.exam.create).not.toHaveBeenCalled()
    expect(mocks.prisma.question.createMany).not.toHaveBeenCalled()
  })

  it("blocks activating a legacy SEB exam with upload questions", async () => {
    const { POST } = await import("@/app/api/exams/[id]/activate/route")
    await expectBlocked(await POST(request("/activate"), params))
    expect(tx.exam.updateMany).not.toHaveBeenCalled()
    expect(mocks.computeKey).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
