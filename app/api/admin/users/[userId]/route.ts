import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireAdmin } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { updateUserRoleSchema } from "@/lib/validators/settings"
import {
  purgeSessionRedisKeys,
  revokeUserSessionsInTx,
} from "@/lib/session-revocation"
import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ userId: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireAdmin(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { userId } = await params

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = updateUserRoleSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  if (userId === session.user.id) {
    return forbidden("Die eigene Rolle kann nicht geändert werden")
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  })
  if (!target) {
    return notFound("Benutzer nicht gefunden")
  }

  if (target.role === parsed.data.role) {
    return NextResponse.json({
      user: { id: target.id, role: target.role },
    })
  }

  // Atomically check and apply: locks admin rows with FOR UPDATE before
  // counting so two concurrent demotions can't both read the same count
  // and both proceed, leaving zero admins (Postgres's default Read
  // Committed isolation would otherwise allow that race). The role change
  // must invalidate the target's existing sessions in the SAME transaction:
  // better-auth serves the session — including the user role — from the
  // signed cookie cache and from the Redis session snapshot, neither of
  // which is re-synced from the User table, so without revocation a demoted
  // teacher/admin keeps the old role for the remaining session lifetime (up
  // to 7 days) and can e.g. still change roles or create/publish exams.
  const result = await prisma.$transaction(async (tx) => {
    if (target.role === "ADMIN" && parsed.data.role !== "ADMIN") {
      const lockedAdmins = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "User" WHERE role = 'ADMIN' FOR UPDATE`
      if (lockedAdmins.length <= 1) {
        return { conflict: true as const }
      }
    }
    const updated = await tx.user.update({
      where: { id: userId },
      data: { role: parsed.data.role },
      select: { id: true, name: true, email: true, role: true },
    })
    const tokens = await revokeUserSessionsInTx(tx, userId)
    return { conflict: false as const, user: updated, tokens }
  })

  if (result.conflict) {
    return conflict(
      "Die Rolle des letzten Administrators kann nicht geändert werden"
    )
  }

  await purgeSessionRedisKeys(result.tokens)

  await createAuditLog({
    action: "USER_ROLE_CHANGED",
    entityType: "User",
    entityId: userId,
    userId: session.user.id,
    metadata: { from: target.role, to: parsed.data.role },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ user: result.user })
}
