import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { generateAccessCode } from "@/lib/access-code"
import { Prisma } from "@/generated/prisma/client"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import { notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const source = await prisma.exam.findUnique({ where: { id } })
  if (!source || source.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }

  const sourceQuestions = await prisma.question.findMany({
    where: { examId: id },
    orderBy: { order: "asc" },
  })

  if (
    source.sebRequired &&
    sourceQuestions.some((question) => question.type === "FILE_UPLOAD")
  ) {
    return validationError(SEB_FILE_UPLOAD_MESSAGE)
  }

  let newExam = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      newExam = await prisma.exam.create({
        data: {
          title: `${source.title} (Kopie)`,
          description: source.description,
          timeLimitMin: source.timeLimitMin,
          shuffleQuestions: source.shuffleQuestions,
          shuffleOptions: source.shuffleOptions,
          showResults: source.showResults,
          sebRequired: source.sebRequired,
          waitingRoom: source.waitingRoom,
          accessCode: generateAccessCode(),
          creatorId: session.user.id,
          folderId: source.folderId,
        },
      })
      break
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        attempt < 4
      )
        continue
      throw e
    }
  }

  if (sourceQuestions.length > 0) {
    await prisma.question.createMany({
      data: sourceQuestions.map((q) => ({
        examId: newExam!.id,
        type: q.type,
        order: q.order,
        title: q.title,
        points: q.points,
        required: q.required,
        config: q.config as Prisma.InputJsonValue,
      })),
    })
  }

  await createAuditLog({
    action: "EXAM_DUPLICATED",
    entityType: "Exam",
    entityId: newExam!.id,
    examId: newExam!.id,
    userId: session.user.id,
    metadata: { sourceExamId: id },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: newExam }, { status: 201 })
}
