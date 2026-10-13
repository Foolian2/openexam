import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { verifyOrigin } from "@/lib/csrf"
import { generateShareToken } from "@/lib/question-bank-share"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

async function assertOwner(id: string, userId: string) {
  const item = await prisma.questionBankItem.findUnique({ where: { id } })
  if (!item || item.creatorId !== userId) return null
  return item
}

/**
 * Generates a share link token for a bank item. Idempotent: calling it again
 * while a token exists returns the same token. A deleted/shared-token expires
 * nothing server-side; the owner can revoke via DELETE.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await assertOwner(id, session.user.id)
  if (!item) return notFound("Frage nicht gefunden")

  if (!item.shareToken) {
    const token = generateShareToken()
    // Atomically claim the token only if still unset, so two concurrent
    // requests can't both generate one and clobber each other.
    const claimed = await prisma.questionBankItem.updateMany({
      where: { id, shareToken: null },
      data: { shareToken: token },
    })
    if (claimed.count === 0) {
      const current = await prisma.questionBankItem.findUnique({
        where: { id },
        select: { shareToken: true },
      })
      return NextResponse.json({ shareToken: current?.shareToken ?? token })
    }
    await createAuditLog({
      action: "QUESTION_BANK_SHARED",
      entityType: "QuestionBankItem",
      entityId: id,
      userId: session.user.id,
      ipAddress: getClientIp(request) ?? undefined,
    })
    return NextResponse.json({ shareToken: token }, { status: 201 })
  }

  return NextResponse.json({ shareToken: item.shareToken })
}

/** Revokes sharing: clears the token, invalidating any previously issued link. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await assertOwner(id, session.user.id)
  if (!item) return notFound("Frage nicht gefunden")

  if (item.shareToken) {
    await prisma.questionBankItem.update({
      where: { id },
      data: { shareToken: null },
    })
    await createAuditLog({
      action: "QUESTION_BANK_SHARE_REVOKED",
      entityType: "QuestionBankItem",
      entityId: id,
      userId: session.user.id,
      ipAddress: getClientIp(request) ?? undefined,
    })
  }

  return new NextResponse(null, { status: 204 })
}
