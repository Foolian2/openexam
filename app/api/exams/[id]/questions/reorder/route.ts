import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { reorderQuestionsSchema } from "@/lib/validators/question"
import { formatZodError } from "@/lib/utils"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"
import { lockEditableExamForQuestionMutation } from "@/lib/exam-question-mutation"

type Params = { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, { params }: Params) {
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
      "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen umsortiert werden"
    )
  }

  const body = await readBoundedJson(request, BODY_LIMITS.SMALL)
  if (body instanceof NextResponse) return body
  const parsed = reorderQuestionsSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const { questionIds } = parsed.data
  try {
    await prisma.$transaction(async (tx) => {
      await lockEditableExamForQuestionMutation(
        tx,
        id,
        session.user.id,
        "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen umsortiert werden"
      )
      const existingQuestions = await tx.question.findMany({
        where: { examId: id },
        select: { id: true },
      })
      const existingIds = new Set(existingQuestions.map((q) => q.id))
      // Compare as a set so duplicates cannot leave a question uncovered.
      const uniqueQuestionIds = new Set(questionIds)
      if (
        uniqueQuestionIds.size !== questionIds.length ||
        uniqueQuestionIds.size !== existingIds.size ||
        questionIds.some((qId) => !existingIds.has(qId))
      ) {
        throw new ApiError(422, "VALIDATION_ERROR", "Ungültige Fragen-IDs")
      }

      // The parent lock serializes reorders with all other question writes.
      // Park positions first because @@unique([examId, order]) is immediate.
      for (const [index, qId] of questionIds.entries()) {
        await tx.question.update({
          where: { id: qId },
          data: { order: -(index + 1) },
        })
      }
      for (const [index, qId] of questionIds.entries()) {
        await tx.question.update({
          where: { id: qId },
          data: { order: index + 1 },
        })
      }
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }

  await createAuditLog({
    action: "QUESTIONS_REORDERED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ ok: true })
}
