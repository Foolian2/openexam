import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import {
  validateQuestionBankUpdate,
  type QuestionType,
} from "@/lib/validators/question"
import { notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

async function assertOwner(id: string, userId: string) {
  const item = await prisma.questionBankItem.findUnique({ where: { id } })
  if (!item || item.creatorId !== userId) return null
  return item
}

export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await assertOwner(id, session.user.id)
  if (!item) return notFound("Frage nicht gefunden")

  return NextResponse.json({ item })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await assertOwner(id, session.user.id)
  if (!item) return notFound("Frage nicht gefunden")

  const body = await readBoundedJson(request, BODY_LIMITS.MEDIUM)
  if (body instanceof NextResponse) return body
  const parsed = validateQuestionBankUpdate(item.type as QuestionType, body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const { config, title, points, required, folderId } = parsed.data

  // Verify the target folder belongs to the caller before assigning it.
  if (folderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: folderId, creatorId: session.user.id },
      select: { id: true },
    })
    if (!folder) {
      return notFound("Ordner nicht gefunden")
    }
  }

  const updated = await prisma.questionBankItem.update({
    where: { id },
    data: {
      ...(title !== undefined && { title }),
      ...(points !== undefined && { points }),
      ...(required !== undefined && { required }),
      ...(config !== undefined && { config: config as never }),
      ...(folderId !== undefined && { folderId }),
    },
  })

  await createAuditLog({
    action: "QUESTION_BANK_ITEM_UPDATED",
    entityType: "QuestionBankItem",
    entityId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ item: updated })
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await assertOwner(id, session.user.id)
  if (!item) return notFound("Frage nicht gefunden")

  // Copy-on-insert means exams that already used this item hold their own
  // independent Question row — deleting the bank item only nulls their
  // bankItemId provenance pointer (onDelete: SetNull), never touches them.
  await prisma.questionBankItem.delete({ where: { id } })

  await createAuditLog({
    action: "QUESTION_BANK_ITEM_DELETED",
    entityType: "QuestionBankItem",
    entityId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return new NextResponse(null, { status: 204 })
}
