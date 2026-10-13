import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import {
  createBankItem,
  findDuplicateBankItem,
} from "@/lib/question-bank-actions"
import { conflict, notFound } from "@/lib/api-response"

type Params = { params: Promise<{ token: string }> }

const SHARED_ITEM_SELECT = {
  id: true,
  type: true,
  title: true,
  points: true,
  required: true,
  config: true,
  creator: { select: { name: true } },
} as const

/**
 * View a shared bank item by token. Staff only (teacher/admin): shared items
 * carry the question config, including solutions, so letting a student account
 * redeem a token would leak answers. The token is a capability the owner
 * controls, not a public hole.
 */
export async function GET(request: NextRequest, { params }: Params) {
  // The call is the access check — staff only, because the item config holds
  // the solution; do not relax this to requireSession. Nothing below needs the
  // session itself.
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed

  const { token } = await params
  // Looked up BY the capability, not by a caller-supplied id: the unguessable
  // shareToken is itself the authorisation, which is why there is no owner
  // comparison to make here. SHARED_ITEM_SELECT keeps the response to the
  // fields sharing is meant to expose.
  // nosemgrep: openexam-findunique-missing-ownership-check
  const item = await prisma.questionBankItem.findUnique({
    where: { shareToken: token },
    select: SHARED_ITEM_SELECT,
  })
  if (!item) return notFound("Geteilte Frage nicht gefunden")

  return NextResponse.json({ item })
}

/**
 * Copies a shared item into the caller's own bank as an independent row
 * (copy, never a live link — matching copy-on-insert everywhere else).
 * Dedupes against the caller's existing items like save-to-bank does.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { token } = await params
  const item = await prisma.questionBankItem.findUnique({
    where: { shareToken: token },
  })
  if (!item) return notFound("Geteilte Frage nicht gefunden")

  if (item.creatorId === session.user.id) {
    return conflict("Diese Frage stammt aus Ihrer eigenen Fragenbank")
  }

  const input = {
    type: item.type as string,
    title: item.title,
    points: item.points,
    required: item.required,
    config: item.config,
  }

  const existing = await findDuplicateBankItem(session.user.id, input)
  if (existing) {
    return NextResponse.json({ item: existing, deduplicated: true })
  }

  const copy = await createBankItem(session.user.id, input, null)

  await createAuditLog({
    action: "QUESTION_BANK_ITEM_CREATED",
    entityType: "QuestionBankItem",
    entityId: copy.id,
    userId: session.user.id,
    metadata: { source: "shared", sourceItemId: item.id },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ item: copy, deduplicated: false }, { status: 201 })
}
