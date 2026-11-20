import { expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
const m = vi.hoisted(() => ({ find: vi.fn(), remove: vi.fn(), audit: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { exam: { findUnique: m.find, deleteMany: m.remove } },
}))
vi.mock("@/lib/api-auth", () => ({
  requireStaff: vi.fn(async () => ({ user: { id: "teacher" } })),
}))
vi.mock("@/lib/audit", () => ({ createAuditLog: m.audit }))
import { DELETE } from "@/app/api/exams/[id]/route"
it("returns conflict if a draft was published before the delete write", async () => {
  m.find.mockResolvedValue({ id: "e", creatorId: "teacher", status: "DRAFT" })
  m.remove.mockResolvedValue({ count: 0 })
  const response = await DELETE(
    new NextRequest("http://localhost/api/exams/e", { method: "DELETE" }),
    { params: Promise.resolve({ id: "e" }) }
  )
  expect(response.status).toBe(409)
  const body = await response.json()
  expect(body).toEqual({
    error: { code: "CONFLICT", message: expect.any(String) },
  })
  expect(m.remove).toHaveBeenCalledWith({
    where: { id: "e", creatorId: "teacher", status: "DRAFT" },
  })
  expect(m.audit).not.toHaveBeenCalled()
})
