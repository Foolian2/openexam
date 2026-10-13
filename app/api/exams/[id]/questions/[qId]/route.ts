import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import {
  validateQuestionUpdate,
  type QuestionType,
} from "@/lib/validators/question"
import { ApiError, conflict, notFound } from "@/lib/api-response"
import { lockEditableExamForQuestionMutation } from "@/lib/exam-question-mutation"

type Params = { params: Promise<{ id: string; qId: string }> }

async function assertOwnerAndQuestion(
  examId: string,
  questionId: string,
  userId: string
) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } })
  if (!exam || exam.creatorId !== userId) return null
  const question = await prisma.question.findUnique({
    where: { id: questionId },
  })
  if (!question || question.examId !== examId) return null
  return { exam, question }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id, qId } = await params
  const found = await assertOwnerAndQuestion(id, qId, session.user.id)
  if (!found) return notFound("Frage nicht gefunden")
  if (found.exam.status !== "DRAFT" && found.exam.status !== "PUBLISHED") {
    return conflict(
      "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen bearbeitet werden"
    )
  }

  const body = await readBoundedJson(request, BODY_LIMITS.MEDIUM)
  if (body instanceof NextResponse) return body
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      await lockEditableExamForQuestionMutation(
        tx,
        id,
        session.user.id,
        "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen bearbeitet werden"
      )
      const question = await tx.question.findUnique({ where: { id: qId } })
      if (!question || question.examId !== id) {
        throw new ApiError(404, "NOT_FOUND", "Frage nicht gefunden")
      }
      const parsed = validateQuestionUpdate(question.type as QuestionType, body)
      if (!parsed.success) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          formatZodError(parsed.error)
        )
      }
      const { config, title, points, required } = parsed.data
      return tx.question.update({
        where: { id: qId },
        data: {
          ...(title !== undefined && { title }),
          ...(points !== undefined && { points }),
          ...(required !== undefined && { required }),
          ...(config !== undefined && { config: config as never }),
        },
      })
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }

  await createAuditLog({
    action: "QUESTION_UPDATED",
    entityType: "Question",
    entityId: qId,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ question: updated })
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id, qId } = await params
  const found = await assertOwnerAndQuestion(id, qId, session.user.id)
  if (!found) return notFound("Frage nicht gefunden")
  if (found.exam.status !== "DRAFT" && found.exam.status !== "PUBLISHED") {
    return conflict(
      "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen gelöscht werden"
    )
  }

  try {
    await prisma.$transaction(async (tx) => {
      await lockEditableExamForQuestionMutation(
        tx,
        id,
        session.user.id,
        "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen gelöscht werden"
      )
      const question = await tx.question.findUnique({ where: { id: qId } })
      if (!question || question.examId !== id) {
        throw new ApiError(404, "NOT_FOUND", "Frage nicht gefunden")
      }
      await tx.question.delete({ where: { id: qId } })
      const siblings = await tx.question.findMany({
        where: { examId: id, order: { gt: question.order } },
        orderBy: { order: "asc" },
      })
      for (const sibling of siblings) {
        await tx.question.update({
          where: { id: sibling.id },
          data: { order: sibling.order - 1 },
        })
      }
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }

  await createAuditLog({
    action: "QUESTION_DELETED",
    entityType: "Question",
    entityId: qId,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return new NextResponse(null, { status: 204 })
}
