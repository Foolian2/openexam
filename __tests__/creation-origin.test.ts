import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  staff: vi.fn(),
  examCreate: vi.fn(),
  folderCreate: vi.fn(),
}))
vi.mock("@/lib/api-auth", () => ({ requireStaff: mocks.staff }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    exam: { create: mocks.examCreate },
    folder: { create: mocks.folderCreate },
  },
}))
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }))

import { POST as createExam } from "@/app/api/exams/route"
import { POST as createFolder } from "@/app/api/folders/route"

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("ALLOWED_ORIGINS", "https://exam.example")
  mocks.staff.mockResolvedValue({ user: { id: "teacher", role: "TEACHER" } })
  mocks.examCreate.mockResolvedValue({ id: "exam" })
  mocks.folderCreate.mockResolvedValue({ id: "folder" })
})

describe.each([
  ["exams", createExam],
  ["folders", createFolder],
] as const)("POST /api/%s Origin enforcement", (path, handler) => {
  it.each([undefined, "https://attacker.example"])(
    "rejects %s before authentication or writes",
    async (origin) => {
      const response = await handler(
        new NextRequest(`https://exam.example/api/${path}`, {
          method: "POST",
          headers: origin ? { origin } : {},
          body: JSON.stringify({ name: "Folder" }),
        })
      )
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe("FORBIDDEN")
      expect(mocks.staff).not.toHaveBeenCalled()
      expect(mocks.examCreate).not.toHaveBeenCalled()
      expect(mocks.folderCreate).not.toHaveBeenCalled()
    }
  )

  it("creates the resource for staff using the configured Origin", async () => {
    const response = await handler(
      new NextRequest(`https://exam.example/api/${path}`, {
        method: "POST",
        headers: { origin: "https://exam.example" },
        body: JSON.stringify(
          path === "exams"
            ? { title: "Exam", timeLimitMin: 30 }
            : { name: "Folder" }
        ),
      })
    )
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual(
      path === "exams" ? { exam: { id: "exam" } } : { folder: { id: "folder" } }
    )
  })

  it("allows the configured Origin through to request validation", async () => {
    const response = await handler(
      new NextRequest(`https://exam.example/api/${path}`, {
        method: "POST",
        headers: { origin: "https://exam.example" },
        body: "{}",
      })
    )
    expect(response.status).toBe(422)
    expect(mocks.staff).toHaveBeenCalledOnce()
  })
})
