import { describe, expect, it, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const getSessionMock = vi.fn()

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
}))

const { requireSession, requireStaff, requireAdmin, requireStudent } =
  await import("@/lib/api-auth")

/**
 * These guards are the single choke point every API route's authentication
 * and role check now runs through, so the failure modes are worth pinning:
 * a guard that returned the session instead of a 401 would silently
 * un-authenticate ~50 routes at once.
 */
function request(): Parameters<typeof requireSession>[0] {
  return { headers: new Headers() } as Parameters<typeof requireSession>[0]
}

function asSession(role: string | null | undefined) {
  return { session: { id: "s1" }, user: { id: "u1", role } }
}

async function statusOf(result: unknown): Promise<number> {
  expect(result).toBeInstanceOf(NextResponse)
  return (result as NextResponse).status
}

async function bodyOf(result: unknown) {
  return (await (result as NextResponse).json()) as {
    error: { code: string; message: string }
  }
}

beforeEach(() => {
  getSessionMock.mockReset()
})

describe("requireSession", () => {
  it("401s when there is no session", async () => {
    getSessionMock.mockResolvedValue(null)
    const result = await requireSession(request())
    expect(await statusOf(result)).toBe(401)
    expect((await bodyOf(result)).error).toEqual({
      code: "UNAUTHORIZED",
      message: "Nicht angemeldet",
    })
  })

  it("returns the session for any signed-in role", async () => {
    for (const role of ["STUDENT", "TEACHER", "ADMIN"]) {
      getSessionMock.mockResolvedValue(asSession(role))
      const result = await requireSession(request())
      expect(result).not.toBeInstanceOf(NextResponse)
      expect((result as { user: { role: string } }).user.role).toBe(role)
    }
  })
})

describe("requireStaff", () => {
  it("401s before it ever considers the role", async () => {
    getSessionMock.mockResolvedValue(null)
    expect(await statusOf(await requireStaff(request()))).toBe(401)
  })

  it("admits TEACHER and ADMIN", async () => {
    for (const role of ["TEACHER", "ADMIN"]) {
      getSessionMock.mockResolvedValue(asSession(role))
      expect(await requireStaff(request())).not.toBeInstanceOf(NextResponse)
    }
  })

  it("403s a STUDENT", async () => {
    getSessionMock.mockResolvedValue(asSession("STUDENT"))
    const result = await requireStaff(request())
    expect(await statusOf(result)).toBe(403)
    expect((await bodyOf(result)).error).toEqual({
      code: "FORBIDDEN",
      message: "Keine Berechtigung",
    })
  })

  // `role` is a better-auth additionalField, so it is typed as possibly
  // absent. Absent must fail closed — the per-route checks this replaced
  // reached the same verdict via `!== "TEACHER" && !== "ADMIN"`.
  it.each([null, undefined, "", "teacher", "SUPERUSER"])(
    "403s a missing or unrecognised role (%s)",
    async (role) => {
      getSessionMock.mockResolvedValue(asSession(role as string | null))
      expect(await statusOf(await requireStaff(request()))).toBe(403)
    }
  )
})

describe("requireAdmin", () => {
  it("admits only ADMIN", async () => {
    getSessionMock.mockResolvedValue(asSession("ADMIN"))
    expect(await requireAdmin(request())).not.toBeInstanceOf(NextResponse)

    for (const role of ["TEACHER", "STUDENT", null, undefined]) {
      getSessionMock.mockResolvedValue(asSession(role as string | null))
      expect(await statusOf(await requireAdmin(request()))).toBe(403)
    }
  })

  it("401s when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null)
    expect(await statusOf(await requireAdmin(request()))).toBe(401)
  })
})

describe("requireStudent", () => {
  it("admits STUDENT and carries the caller's refusal text", async () => {
    getSessionMock.mockResolvedValue(asSession("STUDENT"))
    expect(await requireStudent(request(), "Nur Schüler")).not.toBeInstanceOf(
      NextResponse
    )

    getSessionMock.mockResolvedValue(asSession("TEACHER"))
    const result = await requireStudent(request(), "Nur Schüler")
    expect(await statusOf(result)).toBe(403)
    expect((await bodyOf(result)).error.message).toBe("Nur Schüler")
  })

  it("401s when unauthenticated", async () => {
    getSessionMock.mockResolvedValue(null)
    expect(await statusOf(await requireStudent(request(), "x"))).toBe(401)
  })
})
