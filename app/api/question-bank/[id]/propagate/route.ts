import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { notFound } from "@/lib/api-response"
import {
  EDITABLE_EXAM_STATUSES,
  lockExamsWithQuestionBankCopies,
} from "@/lib/exam-question-mutation"

type Params = { params: Promise<{ id: string }> }

/**
 * Pushes a bank item's current content into every existing copy (Question
 * rows with bankItemId = id) whose exam is still editable — DRAFT or
 * PUBLISHED only. ACTIVE exams are never touched (students may be mid-exam),
 * and CLOSED/GRADED/ARCHIVED copies keep their content for grading
 * integrity.
 *
 * One audit row per affected exam (examId set), so teachers see the
 * propagation in their exam-scoped audit log.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const item = await prisma.questionBankItem.findUnique({ where: { id } })
  if (!item || item.creatorId !== session.user.id) {
    return notFound("Frage nicht gefunden")
  }

  // Lock all owner exam rows that have a copy in one ordered query. This
  // serializes propagation with activation and the exam-scoped question
  // mutators; status is checked only after each row lock is held.
  const result = await prisma.$transaction(async (tx) => {
    const lockedExams = await lockExamsWithQuestionBankCopies(
      tx,
      id,
      item.creatorId
    )
    const editableExamIds = lockedExams
      .filter((exam) =>
        EDITABLE_EXAM_STATUSES.includes(
          exam.status as (typeof EDITABLE_EXAM_STATUSES)[number]
        )
      )
      .map((exam) => exam.id)

    if (editableExamIds.length === 0) {
      return { updated: 0, copiesPerExam: new Map<string, number>() }
    }

    const where = { bankItemId: id, examId: { in: editableExamIds } }
    const updated = await tx.question.updateMany({
      where,
      data: {
        type: item.type,
        title: item.title,
        points: item.points,
        required: item.required,
        config: item.config as never,
      },
    })
    const affected = await tx.question.findMany({
      where,
      select: { examId: true },
    })
    const copiesPerExam = new Map<string, number>()
    for (const copy of affected) {
      copiesPerExam.set(copy.examId, (copiesPerExam.get(copy.examId) ?? 0) + 1)
    }
    return { updated: updated.count, copiesPerExam }
  })

  for (const [examId, copyCount] of result.copiesPerExam) {
    await createAuditLog({
      action: "QUESTION_BANK_ITEM_PROPAGATED",
      entityType: "QuestionBankItem",
      entityId: id,
      examId,
      userId: session.user.id,
      metadata: { bankItemId: id, updatedCopies: copyCount },
      ipAddress: getClientIp(request) ?? undefined,
    })
  }

  return NextResponse.json({
    updated: result.updated,
    exams: [...result.copiesPerExam.keys()],
  })
}
