import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { z } from "zod"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

const moveExamSchema = z.object({ folderId: z.string().nullable() })

export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = moveExamSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const { folderId } = parsed.data
  if (folderId !== null) {
    const folder = await prisma.folder.findUnique({ where: { id: folderId } })
    if (!folder || folder.creatorId !== session.user.id) {
      return notFound("Ordner nicht gefunden")
    }
  }

  const updated = await prisma.exam.update({
    where: { id },
    data: { folderId },
  })

  await createAuditLog({
    action: "EXAM_MOVED_TO_FOLDER",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    metadata: { folderId },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}
