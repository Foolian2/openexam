import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { z } from "zod"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import { lockEditableExamForQuestionMutation } from "@/lib/exam-question-mutation"

type Params = { params: Promise<{ id: string }> }

const fromBankSchema = z.object({ bankItemId: z.string().cuid() })

/**
 * Copies a question bank item into this exam as a brand-new, independent
 * Question row (copy-on-insert — see the bankItemId comment on the Question
 * model in schema.prisma). Editing the bank item afterward never touches
 * this copy; bankItemId is set purely for provenance/traceability.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (exam.status !== "DRAFT" && exam.status !== "PUBLISHED") {
    return conflict(
      "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen hinzugefügt werden"
    )
  }

  const body = await readBoundedJson(request, BODY_LIMITS.SMALL)
  if (body instanceof NextResponse) return body
  const parsed = fromBankSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const bankItem = await prisma.questionBankItem.findUnique({
    where: { id: parsed.data.bankItemId },
  })
  if (!bankItem || bankItem.creatorId !== session.user.id) {
    return notFound("Frage aus der Fragenbank nicht gefunden")
  }

  let question
  try {
    question = await prisma.$transaction(async (tx) => {
      const locked = await lockEditableExamForQuestionMutation(
        tx,
        id,
        session.user.id,
        "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen hinzugefügt werden"
      )
      if (locked.sebRequired && bankItem.type === "FILE_UPLOAD") {
        throw new ApiError(422, "VALIDATION_ERROR", SEB_FILE_UPLOAD_MESSAGE)
      }
      const maxOrder = await tx.question.aggregate({
        where: { examId: id },
        _max: { order: true },
      })
      const nextOrder = (maxOrder._max.order ?? 0) + 1
      return tx.question.create({
        data: {
          examId: id,
          type: bankItem.type,
          title: bankItem.title,
          points: bankItem.points,
          required: bankItem.required,
          config: bankItem.config as never,
          order: nextOrder,
          bankItemId: bankItem.id,
        },
      })
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }

  await createAuditLog({
    action: "QUESTION_ADDED",
    entityType: "Question",
    entityId: question!.id,
    examId: id,
    userId: session.user.id,
    metadata: { source: "bank", bankItemId: bankItem.id },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ question }, { status: 201 })
}
