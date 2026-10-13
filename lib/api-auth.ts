import type { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { forbidden, unauthorized } from "@/lib/api-response"

/**
 * Shared authentication/role gates for API routes. Per-resource ownership
 * (`exam.creatorId === session.user.id`) is still checked in each route.
 *
 * Usage — the `instanceof` test narrows the union, so `session` below is
 * non-null without a cast:
 *
 *     const gate = await requireStaff(request)
 *     if (gate instanceof NextResponse) return gate
 *     const session = gate
 */
export type AuthedSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>

/** Roles permitted to author exams, folders and question-bank content. */
const STAFF_ROLES = new Set(["TEACHER", "ADMIN"])

/**
 * Requires any signed-in account. Callers that then read or mutate a
 * specific resource must still check that it belongs to the caller.
 */
export async function requireSession(
  request: NextRequest
): Promise<AuthedSession | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return unauthorized()
  return session
}

/**
 * Requires a TEACHER or ADMIN account. Note this is a *role* gate only —
 * being staff never implies access to another teacher's exam, so ownership
 * is still checked at the resource.
 */
export async function requireStaff(
  request: NextRequest
): Promise<AuthedSession | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return unauthorized()
  // A missing role is not staff.
  const role = session.user.role
  if (!role || !STAFF_ROLES.has(role)) return forbidden()
  return session
}

/** Requires an ADMIN account (user administration). */
export async function requireAdmin(
  request: NextRequest
): Promise<AuthedSession | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return unauthorized()
  if (session.user.role !== "ADMIN") return forbidden()
  return session
}

/**
 * Requires a STUDENT account. The refusal text differs by route ("only
 * students have sessions" vs "only students can join an exam"), so callers
 * pass their own — the gate is shared, the wording stays local.
 */
export async function requireStudent(
  request: NextRequest,
  forbiddenMessage: string
): Promise<AuthedSession | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return unauthorized()
  if (session.user.role !== "STUDENT") return forbidden(forbiddenMessage)
  return session
}
