import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { verifySebAccess } from "@/lib/seb-guard"
import { publicRequestUrl } from "@/lib/seb-urls"
import { isSubmitted } from "@/lib/session-state"
import { fileKeyBelongsTo } from "@/lib/answer-file-key"
import type { FileUploadAnswer } from "@/lib/types/answers"
import {
  forbidden,
  notFound,
  rateLimited,
  validationError,
} from "@/lib/api-response"

export type ResolvedAnswerFile = {
  questionId: string
  fileKey: string
  fileName: string | undefined
}

/**
 * Every check that gates a FILE_UPLOAD answer's file, shared by the two
 * download routes (`/download` hands out the URL, `/download/file` serves
 * the bytes) so they can never drift apart: owning student (behind the SEB
 * guard while the session is live) or the exam's current staff creator, and a key re-validated against this exact
 * session/question. Returns the error response to send, or the file's key.
 */
export async function resolveAnswerFile(
  request: NextRequest,
  sessionId: string
): Promise<NextResponse | ResolvedAnswerFile> {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const limit = await rateLimit(`session-download:${session.user.id}`, 60, 60)
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const questionId = request.nextUrl.searchParams.get("questionId")
  if (!questionId) {
    return validationError("Frage fehlt")
  }

  const examSession = await prisma.examSession.findUnique({
    where: { id: sessionId },
    include: {
      exam: {
        select: { creatorId: true, sebRequired: true, sebConfigKey: true },
      },
    },
  })
  if (!examSession) {
    return notFound("Sitzung nicht gefunden")
  }
  const isOwner = examSession.userId === session.user.id
  const isTeacher =
    examSession.exam.creatorId === session.user.id &&
    (session.user.role === "TEACHER" || session.user.role === "ADMIN")
  if (!isOwner && !isTeacher) {
    return notFound("Sitzung nicht gefunden")
  }
  // SEB protects exam-taking, not the owner's later access to their submitted
  // attachment from the results page in an ordinary browser. Unknown states
  // still go through the guard; only explicit terminal states bypass it.
  if (isOwner && !isSubmitted(examSession.status)) {
    const guard = await verifySebAccess({
      exam: { id: examSession.examId, ...examSession.exam },
      examSession,
      headers: request.headers,
      requestUrl: publicRequestUrl(request),
      userId: session.user.id,
      ip: getClientIp(request) ?? undefined,
    })
    if (!guard.ok) {
      return forbidden("Safe Exam Browser erforderlich")
    }
  }

  const answer = await prisma.answer.findUnique({
    where: { sessionId_questionId: { sessionId, questionId } },
  })
  const content = answer?.content as unknown as FileUploadAnswer | undefined
  if (!content || content.fileKey === undefined) {
    return notFound("Keine Datei gefunden")
  }

  // Never trust a key straight out of the answer row: the row is
  // student-written (autosave, REST and WS), so re-derive trust here rather
  // than assuming the write path validated it — including for rows stored
  // before that check existed. Same 404 as a missing file, so this can't be
  // used as an oracle for which keys exist.
  if (!fileKeyBelongsTo(content.fileKey, sessionId, questionId)) {
    return notFound("Keine Datei gefunden")
  }

  return { questionId, fileKey: content.fileKey, fileName: content.fileName }
}
