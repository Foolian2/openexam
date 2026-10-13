import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { sebSettingsLockViolation } from "@/lib/seb-config"

const { prismaMock, staffMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    exam: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    examSession: { count: vi.fn() },
    question: { count: vi.fn() },
  },
  staffMock: { requireStaff: vi.fn() },
  auditMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/api-auth", () => ({ requireStaff: staffMock.requireStaff }))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditMock.createAuditLog }))

const EXAM_ID = "c000000000000000000000001"
const OWNER_ID = "teacher-1"

function exam(overrides: Record<string, unknown> = {}) {
  return {
    id: EXAM_ID,
    creatorId: OWNER_ID,
    status: "PUBLISHED",
    sebConfigKey: null,
    sebRequired: false,
    allowSpellCheck: false,
    scheduledStart: null,
    scheduledEnd: null,
    waitingRoom: false,
    ...overrides,
  }
}

function request(body: unknown) {
  return new NextRequest(`http://localhost/api/exams/${EXAM_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: EXAM_ID }) }

async function patch(body: unknown) {
  const { PATCH } = await import("@/app/api/exams/[id]/route")
  return PATCH(request(body), params)
}

beforeEach(() => {
  vi.clearAllMocks()
  prismaMock.$queryRaw.mockResolvedValue([exam()])
  prismaMock.$transaction.mockImplementation((callback) => callback(prismaMock))
  prismaMock.question.count.mockResolvedValue(0)
  prismaMock.examSession.count.mockResolvedValue(0)
  prismaMock.exam.findUniqueOrThrow.mockResolvedValue({ waitingRoom: false })
  staffMock.requireStaff.mockResolvedValue({ user: { id: OWNER_ID } })
  auditMock.createAuditLog.mockResolvedValue(undefined)
  prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
})

describe("PATCH /api/exams/[id] guards", () => {
  it("allows a frozen SEB setting repeated with its persisted value", async () => {
    const persisted = exam({ sebConfigKey: "frozen-key", sebRequired: true })
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted)

    const response = await patch({ sebRequired: true })

    expect(response.status).toBe(200)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["DRAFT", "PUBLISHED"] },
          sebRequired: true,
        }),
      })
    )
    expect(
      prismaMock.exam.updateMany.mock.calls[0][0].where
    ).not.toHaveProperty("sebConfigKey")
  })

  it("rejects a patch whose status changed after the initial read", async () => {
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(exam())
      .mockResolvedValueOnce(exam({ status: "ACTIVE" }))
    prismaMock.exam.updateMany.mockResolvedValueOnce({ count: 0 })

    const response = await patch({ title: "Updated" })

    expect(response.status).toBe(409)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledTimes(1)
    expect(auditMock.createAuditLog).not.toHaveBeenCalled()
  })

  it("validates a partial schedule edit against the persisted other bound", async () => {
    prismaMock.exam.findUnique.mockResolvedValueOnce(
      exam({ scheduledStart: new Date("2030-01-01T10:00:00.000Z") })
    )

    const response = await patch({ scheduledEnd: "2030-01-01T09:00:00.000Z" })

    expect(response.status).toBe(422)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })

  it("clears a schedule bound with null", async () => {
    const persisted = exam({
      scheduledStart: new Date("2030-01-01T10:00:00.000Z"),
      scheduledEnd: new Date("2030-01-01T11:00:00.000Z"),
    })
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce({ ...persisted, scheduledStart: null })

    const response = await patch({ scheduledStart: null })

    expect(response.status).toBe(200)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { scheduledStart: null } })
    )
  })

  it("checks a new start against a cleared end as unbounded", async () => {
    const persisted = exam({
      scheduledStart: new Date("2030-01-01T10:00:00.000Z"),
      scheduledEnd: new Date("2030-01-01T11:00:00.000Z"),
    })
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted)

    const response = await patch({
      scheduledStart: "2030-01-01T12:00:00.000Z",
      scheduledEnd: null,
    })

    expect(response.status).toBe(200)
  })

  it("guards schedule and SEB comparisons with the values read from storage", async () => {
    const scheduledStart = new Date("2030-01-01T10:00:00.000Z")
    const scheduledEnd = new Date("2030-01-01T11:00:00.000Z")
    const persisted = exam({ scheduledStart, scheduledEnd })
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(persisted)
      .mockResolvedValueOnce(persisted)

    const response = await patch({ title: "Updated" })

    expect(response.status).toBe(200)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["DRAFT", "PUBLISHED"] },
          scheduledStart,
          scheduledEnd,
          sebRequired: false,
          allowSpellCheck: false,
        }),
      })
    )
  })

  it("rejects a changed SEB value if the key freezes before the guarded write", async () => {
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(exam())
      .mockResolvedValueOnce(exam({ sebConfigKey: "frozen-key" }))
    prismaMock.exam.updateMany.mockResolvedValueOnce({ count: 0 })

    const response = await patch({ sebRequired: true })

    expect(response.status).toBe(409)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledTimes(1)
  })

  it("retries safely when a concurrent freeze already stored the requested SEB value", async () => {
    const current = exam({ sebConfigKey: "frozen-key", sebRequired: true })
    prismaMock.exam.findUnique
      .mockResolvedValueOnce(exam())
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, title: "Updated" })
    prismaMock.exam.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })

    const response = await patch({ sebRequired: true, title: "Updated" })

    expect(response.status).toBe(200)
    expect(prismaMock.exam.updateMany).toHaveBeenCalledTimes(2)
    expect(
      prismaMock.exam.updateMany.mock.calls[1][0].where
    ).not.toHaveProperty("sebConfigKey")
    expect(auditMock.createAuditLog).toHaveBeenCalledTimes(1)
  })
})

describe("frozen SEB value comparison", () => {
  it("allows persisted values and rejects only a changed locked value", () => {
    const persisted = {
      sebConfigKey: "frozen-key",
      sebRequired: true,
      allowSpellCheck: false,
    }

    expect(
      sebSettingsLockViolation(persisted, {
        sebRequired: true,
        allowSpellCheck: false,
      })
    ).toBeNull()
    expect(sebSettingsLockViolation(persisted, { sebRequired: false })).toBe(
      "sebRequired"
    )
    expect(sebSettingsLockViolation(persisted, { allowSpellCheck: true })).toBe(
      "allowSpellCheck"
    )
  })
})

describe("PATCH /api/exams/[id] with students in the waiting room", () => {
  const waitingExam = exam({ waitingRoom: true })

  beforeEach(() => {
    prismaMock.exam.findUnique.mockResolvedValue(waitingExam)
    prismaMock.exam.findUniqueOrThrow.mockResolvedValue({ waitingRoom: true })
    prismaMock.examSession.count.mockResolvedValue(2)
  })

  it("refuses to switch the room off, counting under the exam-row lock", async () => {
    const response = await patch({ waitingRoom: false })

    expect(response.status).toBe(409)
    expect((await response.json()).error.message).toContain("Warteraum")
    // Counted inside the transaction, after the FOR UPDATE row lock that
    // waiting-room joins share.
    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prismaMock.examSession.count.mock.invocationCallOrder[0]
    )
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })

  it("refuses to change the SEB requirement in either direction", async () => {
    expect((await patch({ sebRequired: true })).status).toBe(409)
    prismaMock.$queryRaw.mockResolvedValue([exam({ sebRequired: true })])
    prismaMock.exam.findUnique.mockResolvedValue(
      exam({ waitingRoom: true, sebRequired: true })
    )
    expect((await patch({ sebRequired: false })).status).toBe(409)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })

  it("still saves autosave's unchanged flags and other edits", async () => {
    const response = await patch({
      title: "Neu",
      waitingRoom: true,
      sebRequired: false,
    })

    expect(response.status).toBe(200)
    expect(prismaMock.exam.updateMany).toHaveBeenCalled()
  })

  it("lets the room be switched off while nobody is waiting", async () => {
    prismaMock.examSession.count.mockResolvedValue(0)
    expect((await patch({ waitingRoom: false })).status).toBe(200)
  })
})

describe("PATCH /api/exams/[id] scheduled end with a shared start", () => {
  it("rejects switching the room on over a stored end", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      exam({ scheduledEnd: new Date("2030-01-01T11:00:00.000Z") })
    )

    const response = await patch({ waitingRoom: true })

    expect(response.status).toBe(422)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })

  it("rejects setting an end over a stored waiting room", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(exam({ waitingRoom: true }))

    const response = await patch({ scheduledEnd: "2030-01-01T11:00:00.000Z" })

    expect(response.status).toBe(422)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })

  it("accepts switching the room on while clearing the end", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      exam({ scheduledEnd: new Date("2030-01-01T11:00:00.000Z") })
    )

    const response = await patch({ waitingRoom: true, scheduledEnd: null })

    expect(response.status).toBe(200)
    expect(prismaMock.exam.updateMany.mock.calls[0][0].where).toMatchObject({
      waitingRoom: false,
    })
  })
})
