import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { prisma } from "@/lib/prisma"
import { setBookmarkSchema } from "@/lib/validators/session"
import { formatZodError } from "@/lib/utils"
import { OPEN_STATUSES, isOpen, pastDeadline } from "@/lib/session-state"
import { verifySebAccess } from "@/lib/seb-guard"
import {
  gateActiveDevice,
  getExamDeviceId,
  isActiveDevice,
} from "@/lib/exam-device"
import { getClientIp } from "@/lib/client-ip"
import { publicRequestUrl } from "@/lib/seb-urls"
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  sessionReplaced,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

export async function PUT(request: NextRequest, { params }: Params) {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const deviceId = getExamDeviceId(request.headers)
  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = setBookmarkSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: true },
  })
  if (!examSession || examSession.userId !== authed.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  const guard = await verifySebAccess({
    exam: examSession.exam,
    examSession,
    headers: request.headers,
    requestUrl: publicRequestUrl(request),
    userId: authed.user.id,
    ip: getClientIp(request) ?? undefined,
  })
  if (!guard.ok) {
    return forbidden("Safe Exam Browser erforderlich")
  }
  if (!isActiveDevice(examSession, authed.session.id, deviceId)) {
    return sessionReplaced()
  }
  if (
    !isOpen(examSession.status) ||
    pastDeadline(examSession.effectiveEndTime)
  ) {
    return conflict("Sitzung ist nicht mehr aktiv")
  }
  const question = await prisma.question.findFirst({
    where: { id: parsed.data.questionId, examId: examSession.examId },
    select: { id: true },
  })
  if (!question) return notFound("Frage nicht gefunden")
  try {
    await prisma.$transaction(async (tx) => {
      await gateActiveDevice(tx, {
        id,
        status: { in: OPEN_STATUSES },
        authSessionId: authed.session.id,
        deviceId,
      })
      if (parsed.data.bookmarked) {
        await tx.questionBookmark.upsert({
          where: {
            sessionId_questionId: { sessionId: id, questionId: question.id },
          },
          create: { sessionId: id, questionId: question.id },
          update: {},
        })
      } else {
        await tx.questionBookmark.deleteMany({
          where: { sessionId: id, questionId: question.id },
        })
      }
    })
  } catch (error) {
    if (error instanceof ApiError) return error.toResponse()
    throw error
  }
  return NextResponse.json({
    questionId: question.id,
    bookmarked: parsed.data.bookmarked,
  })
}
