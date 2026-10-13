import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { sanitizeQuestion, seededShuffle } from "@/lib/exam-session"
import { verifySebAccess } from "@/lib/seb-guard"
import { getExamDeviceId, isActiveDevice } from "@/lib/exam-device"
import { publicRequestUrl } from "@/lib/seb-urls"
import {
  apiError,
  forbidden,
  notFound,
  rateLimited,
  sessionReplaced,
} from "@/lib/api-response"
import { isWaiting } from "@/lib/session-state"
import { loadSessionAnswers } from "@/lib/ws-answer-buffer"

type Params = { params: Promise<{ id: string }> }

/**
 * Full state for the exam-taking client: exam metadata, sanitized questions
 * (solutions stripped), saved answers and server-authoritative timing.
 *
 * Saved answers include ones ws-backend has acked but not yet flushed to
 * Postgres: the client drops an answer from its own retry buffer on the ack,
 * so a reload inside the flush window would otherwise render it as missing.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const limit = await rateLimit(`session-get:${session.user.id}`, 60, 60)
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      bookmarks: { select: { questionId: true } },
    },
  })
  if (!examSession || examSession.userId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }

  const { exam } = examSession

  const guard = await verifySebAccess({
    exam,
    examSession,
    headers: request.headers,
    requestUrl: publicRequestUrl(request),
    userId: session.user.id,
    ip: getClientIp(request) ?? undefined,
  })
  if (!guard.ok) {
    return forbidden("Safe Exam Browser erforderlich")
  }
  if (
    !isActiveDevice(
      examSession,
      session.session.id,
      getExamDeviceId(request.headers)
    )
  ) {
    return sessionReplaced()
  }

  // Shared start: no questions before the clock begins, neither in the
  // waiting room nor during the countdown after Start. The runner sends the
  // student back to the waiting room on this code.
  if (
    isWaiting(examSession.status) ||
    (examSession.startedAt && examSession.startedAt > new Date())
  ) {
    return apiError("NOT_STARTED", "Die Prüfung hat noch nicht begonnen.", 409)
  }

  let questions = examSession.exam.questions.map((row) => {
    const seed = `${id}:${row.id}`
    const q = sanitizeQuestion(row, seed)
    if (exam.shuffleOptions && q.type === "MULTIPLE_CHOICE") {
      q.config = { ...q.config, options: seededShuffle(q.config.options, seed) }
    }
    return {
      id: q.id,
      type: q.type,
      order: q.order,
      title: q.title,
      points: q.points,
      required: q.required,
      config: q.config,
    }
  })
  if (exam.shuffleQuestions) {
    questions = seededShuffle(questions, id)
  }

  const answers = await loadSessionAnswers({
    examId: exam.id,
    sessionId: examSession.id,
    questionIds: exam.questions.map((q) => q.id),
    // A submitted session is redirected to /complete by the client.
    live:
      examSession.status === "IN_PROGRESS" || examSession.status === "LOCKED",
  })

  return NextResponse.json({
    session: {
      id: examSession.id,
      status: examSession.status,
      startedAt: examSession.startedAt,
      submittedAt: examSession.submittedAt,
      effectiveEndTime: examSession.effectiveEndTime,
      timeExtensionMin: examSession.timeExtensionMin,
    },
    exam: {
      id: exam.id,
      title: exam.title,
      description: exam.description,
      status: exam.status,
      timeLimitMin: exam.timeLimitMin,
      sebRequired: exam.sebRequired,
    },
    questions,
    answers,
    bookmarkedQuestionIds: examSession.bookmarks.map(
      (bookmark) => bookmark.questionId
    ),
    serverNow: new Date().toISOString(),
  })
}
