import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { createAuditLog } from "@/lib/audit"
import { readBoundedJson } from "@/lib/body-size"
import { verifyOrigin } from "@/lib/csrf"
import { validationError } from "@/lib/api-response"

const updateAutoArchiveSchema = z.object({ enabled: z.boolean() })

export async function PATCH(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, 1024)
  if (body instanceof NextResponse) return body

  const parsed = updateAutoArchiveSchema.safeParse(body)
  if (!parsed.success) {
    return validationError("Ungültige Anfrage")
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { autoArchiveEnabled: parsed.data.enabled },
  })

  await createAuditLog({
    action: parsed.data.enabled
      ? "AUTO_ARCHIVE_ENABLED"
      : "AUTO_ARCHIVE_DISABLED",
    entityType: "User",
    entityId: session.user.id,
    userId: session.user.id,
    ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
  })

  return NextResponse.json({ enabled: parsed.data.enabled })
}
