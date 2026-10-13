import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { createQuestionSchema } from "@/lib/validators/question"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import { lockEditableExamForQuestionMutation } from "@/lib/exam-question-mutation"

type Params = { params: Promise<{ id: string }> }

async function assertOwner(examId: string, userId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } })
  if (!exam || exam.creatorId !== userId) return null
  return exam
}

export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await assertOwner(id, session.user.id)
  if (!exam) return notFound("Prüfung nicht gefunden")

  const questions = await prisma.question.findMany({
    where: { examId: id },
    orderBy: { order: "asc" },
  })

  return NextResponse.json({ questions })
}

export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  // Preserve the fast ownership/state response. The transaction repeats both
  // checks after acquiring the parent lock before any question write.
  const exam = await assertOwner(id, session.user.id)
  if (!exam) return notFound("Prüfung nicht gefunden")
  if (exam.status !== "DRAFT" && exam.status !== "PUBLISHED") {
    return conflict(
      "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen hinzugefügt werden"
    )
  }

  const body = await readBoundedJson(request, BODY_LIMITS.MEDIUM)
  if (body instanceof NextResponse) return body
  const parsed = createQuestionSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const { type, config, ...rest } = parsed.data as {
    type: string
    config: unknown
    title: string
    points: number
    required: boolean
  }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const locked = await lockEditableExamForQuestionMutation(
        tx,
        id,
        session.user.id,
        "Fragen können nur bei Entwürfen/veröffentlichten Prüfungen hinzugefügt werden"
      )
      if (locked.sebRequired && type === "FILE_UPLOAD") {
        throw new ApiError(422, "VALIDATION_ERROR", SEB_FILE_UPLOAD_MESSAGE)
      }
      const maxOrder = await tx.question.aggregate({
        where: { examId: id },
        _max: { order: true },
      })
      const order = (maxOrder._max.order ?? 0) + 1
      const created = await tx.question.create({
        data: {
          examId: id,
          type: type as never,
          config: config as never,
          order,
          ...rest,
        },
      })
      return { question: created, nextOrder: order }
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }
  const { question, nextOrder } = result

  await createAuditLog({
    action: "QUESTION_ADDED",
    entityType: "Question",
    entityId: question!.id,
    examId: id,
    userId: session.user.id,
    metadata: { type, order: nextOrder },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ question }, { status: 201 })
}
