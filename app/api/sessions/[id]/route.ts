import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { sanitizeQuestion, seededShuffle } from "@/lib/exam-session"
import { verifySebAccess } from "@/lib/seb-guard"
import { publicRequestUrl } from "@/lib/seb-urls"
import { apiError, forbidden, notFound, rateLimited } from "@/lib/api-response"
import { isWaiting } from "@/lib/session-state"
import { loadSessionAnswers } from "@/lib/ws-answer-buffer"
import { redis } from "@/lib/redis"

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
  let examSession = await prisma.examSession.findUnique({
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
    exam.sebRequired &&
    examSession.status === "IN_PROGRESS" &&
    !examSession.startedAt
  ) {
    // Start only after Config Key verification (including the macOS JS API
    // path). One statement locks the session and uses the live extension,
    // so concurrent loads cannot restart the clock or lose a teacher grant.
    const now = new Date()
    const started = await prisma.$queryRaw<
      Pick<
        typeof examSession,
        | "status"
        | "startedAt"
        | "effectiveEndTime"
        | "lastSeenAt"
        | "timeExtensionMin"
      >[]
    >`
      UPDATE "ExamSession" AS s
      SET "startedAt" = ${now}::timestamp,
          -- Cap only the base duration at the scheduled end, then add the
          -- grants made while the session was pending: teacher extensions
          -- may run past the schedule (see the extend routes).
          "effectiveEndTime" = LEAST(
            ${now}::timestamp + e."timeLimitMin" * interval '1 minute',
            CASE WHEN e."waitingRoom" THEN NULL ELSE e."scheduledEnd" END
          ) + s."timeExtensionMin" * interval '1 minute',
          "lastSeenAt" = ${now}::timestamp
      FROM "Exam" AS e
      WHERE s."id" = ${id} AND s."examId" = e."id"
        AND s."status" = 'IN_PROGRESS' AND s."startedAt" IS NULL
        AND e."status" = 'ACTIVE'
      RETURNING s."status", s."startedAt", s."effectiveEndTime",
                s."lastSeenAt", s."timeExtensionMin"
    `
    // A concurrent load may have won, or the teacher may have locked/ended
    // the session. Read the settled state instead of inventing a new clock.
    const settled =
      started[0] ??
      (await prisma.examSession.findUnique({
        where: { id },
      }))
    if (!settled?.startedAt || settled.status !== "IN_PROGRESS") {
      return forbidden("Sitzung kann nicht gestartet werden")
    }
    if (started[0]) {
      // Only the load that set the clock records the start; the join logged
      // SESSION_RESERVED when the access code was entered.
      await createAuditLog({
        action: "SESSION_STARTED",
        entityType: "ExamSession",
        entityId: id,
        examId: exam.id,
        userId: session.user.id,
        ipAddress: getClientIp(request) ?? undefined,
      })
      // The monitor's socket does not resend snapshots and REST polls only
      // every 30s; push the winning clock so the row shows it at once. The
      // control handler also syncs the student's timer. Non-fatal: the next
      // monitor poll reconciles it.
      try {
        await redis.publish(
          `exam:${exam.id}:control`,
          JSON.stringify({
            type: "SESSION_EXTENDED",
            sessionId: id,
            effectiveEndTime: settled.effectiveEndTime,
            timeExtensionMin: settled.timeExtensionMin,
          })
        )
      } catch {
        // WebSocket server may not be running in dev
      }
    }
    examSession = { ...examSession, ...settled }
  }

  // A reservation locked by the teacher before the student first entered has
  // no clock and the start path above skips it. Withhold the questions until
  // an unlock lets the first verified load start the timer.
  if (
    exam.sebRequired &&
    examSession.status === "LOCKED" &&
    !examSession.startedAt
  ) {
    return forbidden("Sitzung ist gesperrt")
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
