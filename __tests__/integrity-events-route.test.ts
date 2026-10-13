import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { prismaMock, authMock } = vi.hoisted(() => ({
  prismaMock: {
    examSession: { findUnique: vi.fn() },
    integrityEvent: { findMany: vi.fn() },
  },
  authMock: { api: { getSession: vi.fn() } },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/auth", () => ({ auth: authMock }))

import { GET } from "@/app/api/sessions/[id]/integrity-events/route"

const SESSION_ID = "session1"

function get() {
  return GET(
    new NextRequest(
      `https://localhost/api/sessions/${SESSION_ID}/integrity-events`
    ),
    { params: Promise.resolve({ id: SESSION_ID }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.api.getSession.mockResolvedValue({
    user: { id: "teacher1", role: "TEACHER" },
  })
  prismaMock.examSession.findUnique.mockResolvedValue({
    id: SESSION_ID,
    exam: { creatorId: "teacher1" },
  })
  prismaMock.integrityEvent.findMany.mockResolvedValue([])
})

describe("GET /api/sessions/[id]/integrity-events", () => {
  it("rejects unauthenticated requests", async () => {
    authMock.api.getSession.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it("refuses students, including the session's own student", async () => {
    authMock.api.getSession.mockResolvedValue({
      user: { id: "student1", role: "STUDENT" },
    })
    expect((await get()).status).toBe(403)
    expect(prismaMock.integrityEvent.findMany).not.toHaveBeenCalled()
  })

  it("hides another teacher's session as 404", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      exam: { creatorId: "teacher2" },
    })
    expect((await get()).status).toBe(404)
    expect(prismaMock.integrityEvent.findMany).not.toHaveBeenCalled()
  })

  it("answers 404 for a missing session", async () => {
    prismaMock.examSession.findUnique.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
  })

  it("returns the session's events in server receive order", async () => {
    const createdAt = new Date("2026-10-08T09:00:00Z")
    const clientTime = new Date("2026-10-08T08:00:00Z")
    prismaMock.integrityEvent.findMany.mockResolvedValue([
      { id: "e1", kind: "TAB_SWITCH", detail: null, createdAt, clientTime },
    ])

    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      events: [
        {
          id: "e1",
          kind: "TAB_SWITCH",
          detail: null,
          createdAt: createdAt.toISOString(),
          clientTime: clientTime.toISOString(),
        },
      ],
    })
    // Ordered by createdAt, not the client-claimed time (see the route).
    expect(prismaMock.integrityEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sessionId: SESSION_ID },
        orderBy: { createdAt: "asc" },
      })
    )
  })
})
