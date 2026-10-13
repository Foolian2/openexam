import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  examSession: vi.fn(),
  answer: vi.fn(),
  seb: vi.fn(),
}))
vi.mock("@/lib/api-auth", () => ({ requireSession: mocks.session }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: { findUnique: mocks.examSession },
    answer: { findUnique: mocks.answer },
  },
}))
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
}))
vi.mock("@/lib/seb-guard", () => ({ verifySebAccess: mocks.seb }))
vi.mock("@/lib/seb-urls", () => ({
  publicRequestUrl: () => "https://localhost/api/file",
}))
import { resolveAnswerFile } from "@/lib/answer-file-access"

const key = "sessions/s1/q1/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf"
function request() {
  return new NextRequest("https://localhost/api/file?questionId=q1")
}
function row(status: string) {
  return {
    id: "s1",
    examId: "e1",
    userId: "student",
    status,
    exam: { creatorId: "teacher", sebRequired: true, sebConfigKey: "key" },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ user: { id: "student", role: "STUDENT" } })
  mocks.examSession.mockResolvedValue(row("SUBMITTED"))
  mocks.answer.mockResolvedValue({
    content: { type: "FILE_UPLOAD", fileKey: key, fileName: "answer.pdf" },
  })
  mocks.seb.mockResolvedValue({ ok: false })
})

describe("answer-file access", () => {
  it.each(["SUBMITTED", "AUTO_SUBMITTED"])(
    "allows the owner to download after %s without SEB",
    async (status) => {
      mocks.examSession.mockResolvedValue(row(status))
      expect(await resolveAnswerFile(request(), "s1")).toEqual({
        questionId: "q1",
        fileKey: key,
        fileName: "answer.pdf",
      })
      expect(mocks.seb).not.toHaveBeenCalled()
    }
  )
  it.each(["IN_PROGRESS", "LOCKED", "UNKNOWN"])(
    "still enforces SEB for %s",
    async (status) => {
      mocks.examSession.mockResolvedValue(row(status))
      const res = await resolveAnswerFile(request(), "s1")
      expect(res).toBeInstanceOf(NextResponse)
      expect((res as NextResponse).status).toBe(403)
      expect(mocks.answer).not.toHaveBeenCalled()
    }
  )
  it("rejects another student before checking files", async () => {
    mocks.session.mockResolvedValue({ user: { id: "other", role: "STUDENT" } })
    expect(
      ((await resolveAnswerFile(request(), "s1")) as NextResponse).status
    ).toBe(404)
    expect(mocks.answer).not.toHaveBeenCalled()
  })
  it("rejects an exam creator demoted to student", async () => {
    mocks.session.mockResolvedValue({
      user: { id: "teacher", role: "STUDENT" },
    })
    expect(
      ((await resolveAnswerFile(request(), "s1")) as NextResponse).status
    ).toBe(404)
    expect(mocks.answer).not.toHaveBeenCalled()
  })
  it.each(["TEACHER", "ADMIN"])("allows an owning %s", async (role) => {
    mocks.session.mockResolvedValue({ user: { id: "teacher", role } })
    expect(await resolveAnswerFile(request(), "s1")).toEqual({
      questionId: "q1",
      fileKey: key,
      fileName: "answer.pdf",
    })
  })
  it("still rejects file keys from another session after submission", async () => {
    mocks.answer.mockResolvedValue({
      content: { fileKey: key.replace("/s1/", "/s2/") },
    })
    expect(
      ((await resolveAnswerFile(request(), "s1")) as NextResponse).status
    ).toBe(404)
  })
})
