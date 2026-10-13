import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { verifyOrigin } from "@/lib/csrf"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Duplicates a bank item for the caller. Copy-on-insert means exams that used
 * the original are never affected; the copy is a fresh, independent row.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await prisma.questionBankItem.findUnique({ where: { id } })
  if (!item || item.creatorId !== session.user.id) {
    return notFound("Frage nicht gefunden")
  }

  const copy = await prisma.questionBankItem.create({
    data: {
      type: item.type,
      title: `${item.title} (Kopie)`,
      points: item.points,
      required: item.required,
      config: item.config as never,
      creatorId: session.user.id,
      folderId: item.folderId,
    },
  })

  await createAuditLog({
    action: "QUESTION_BANK_ITEM_DUPLICATED",
    entityType: "QuestionBankItem",
    entityId: copy.id,
    userId: session.user.id,
    metadata: { sourceItemId: id },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ item: copy }, { status: 201 })
}
