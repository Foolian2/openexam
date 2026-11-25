import { beforeEach, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  session: vi.fn(),
  question: vi.fn(),
  gate: vi.fn(),
  reread: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}))
const tx = {
  examSession: { updateMany: m.gate, findUnique: m.reread },
  questionBookmark: { upsert: m.upsert, deleteMany: m.deleteMany },
}
vi.mock("@/lib/api-auth", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "student" },
    session: { id: "auth-1" },
  })),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: { findUnique: m.session },
    question: { findFirst: m.question },
    $transaction: async (fn: (client: unknown) => unknown) => fn(tx),
  },
}))
vi.mock("@/lib/seb-guard", () => ({
  verifySebAccess: vi.fn(async () => ({ ok: true })),
}))
vi.mock("@/lib/seb-urls", () => ({
  publicRequestUrl: () => "https://localhost/bookmarks",
}))

import { PUT } from "@/app/api/sessions/[id]/bookmarks/route"

function bookmark() {
  return PUT(
    new NextRequest("https://localhost/api/sessions/s1/bookmarks", {
      method: "PUT",
      body: JSON.stringify({
        questionId: "c000000000000000000000003",
        bookmarked: true,
      }),
    }),
    { params: Promise.resolve({ id: "s1" }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  m.session.mockResolvedValue({
    id: "s1",
    userId: "student",
    examId: "e1",
    status: "IN_PROGRESS",
    effectiveEndTime: null,
    exam: {},
  })
  m.question.mockResolvedValue({ id: "c000000000000000000000003" })
  m.gate.mockResolvedValue({ count: 1 })
})

it("stores a bookmark only after the guarded session-row update", async () => {
  const response = await bookmark()
  expect(response.status).toBe(200)
  expect(m.gate).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ AND: expect.any(Array) }),
    })
  )
  expect(m.gate.mock.invocationCallOrder[0]).toBeLessThan(
    m.upsert.mock.invocationCallOrder[0]
  )
})

it("rejects a takeover between the initial read and bookmark write", async () => {
  m.gate.mockResolvedValue({ count: 0 })
  m.reread.mockResolvedValue({ activeAuthSessionId: "auth-2" })
  const response = await bookmark()
  expect(response.status).toBe(409)
  expect((await response.json()).error.code).toBe("SESSION_REPLACED")
  expect(m.upsert).not.toHaveBeenCalled()
})
