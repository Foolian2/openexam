import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { z } from "zod"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { verifyOrigin } from "@/lib/csrf"
import {
  createBankItem,
  findDuplicateBankItem,
} from "@/lib/question-bank-actions"
import { notFound, validationError } from "@/lib/api-response"

const saveToBankSchema = z.object({
  examId: z.string().cuid(),
  questionId: z.string().cuid(),
  folderId: z.string().cuid().optional(),
})

/**
 * Saves an exam question into the caller's Fragenbank as a reusable item.
 * The bank item is a copy (consistent with copy-on-insert in the other
 * direction); the question's bankItemId provenance pointer is NOT set, since
 * the question did not originate from this bank item.
 *
 * Dedupe: if the caller already owns an identical item (same type/title/
 * config), that item is returned instead of creating a duplicate.
 */
export async function POST(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, BODY_LIMITS.SMALL)
  if (body instanceof NextResponse) return body
  const parsed = saveToBankSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const { examId, questionId, folderId } = parsed.data

  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, creatorId: true },
  })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }

  const question = await prisma.question.findFirst({
    where: { id: questionId, examId },
  })
  if (!question) {
    return notFound("Frage nicht gefunden")
  }

  if (folderId) {
    const folder = await prisma.folder.findFirst({
      where: { id: folderId, creatorId: session.user.id },
      select: { id: true },
    })
    if (!folder) {
      return notFound("Ordner nicht gefunden")
    }
  }

  const input = {
    type: question.type as string,
    title: question.title,
    points: question.points,
    required: question.required,
    config: question.config,
  }

  const existing = await findDuplicateBankItem(session.user.id, input)
  if (existing) {
    return NextResponse.json({ item: existing, deduplicated: true })
  }

  const item = await createBankItem(session.user.id, input, folderId ?? null)

  await createAuditLog({
    action: "QUESTION_SAVED_TO_BANK",
    entityType: "QuestionBankItem",
    entityId: item.id,
    examId,
    userId: session.user.id,
    metadata: { source: "exam", questionId, examId },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ item, deduplicated: false }, { status: 201 })
}
