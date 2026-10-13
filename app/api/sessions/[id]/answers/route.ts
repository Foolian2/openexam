import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { rateLimit } from "@/lib/rate-limit"
import { submitAnswerSchema } from "@/lib/validators/answer"
import { fileKeyBelongsTo } from "@/lib/answer-file-key"
import { OPEN_STATUSES, pastDeadline } from "@/lib/session-state"
import { verifySebAccess } from "@/lib/seb-guard"
import { publicRequestUrl } from "@/lib/seb-urls"
import {
  ApiError,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** Autosave endpoint: upserts a single answer for the caller's session. */
export async function PUT(request: NextRequest, { params }: Params) {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  // Generous: this is the autosave path, called on every keystroke pause.
  const limit = await rateLimit(`session-answers:${session.user.id}`, 120, 60)
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: true },
  })
  if (!examSession || examSession.userId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }
  const guard = await verifySebAccess({
    exam: examSession.exam,
    examSession,
    headers: request.headers,
    requestUrl: publicRequestUrl(request),
    userId: session.user.id,
    ip: getClientIp(request) ?? undefined,
  })
  if (!guard.ok) {
    return forbidden("Safe Exam Browser erforderlich")
  }
  if (pastDeadline(examSession.effectiveEndTime)) {
    return conflict("Bearbeitungszeit ist abgelaufen")
  }

  const body = await readBoundedJson(request, BODY_LIMITS.LARGE)
  if (body instanceof NextResponse) return body
  const parsed = submitAnswerSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const { questionId, content, clientSeq } = parsed.data

  const question = await prisma.question.findUnique({
    where: { id: questionId },
  })
  if (!question || question.examId !== examSession.examId) {
    return notFound("Frage nicht gefunden")
  }
  if (content.type !== question.type) {
    return validationError("Antworttyp passt nicht zur Frage")
  }
  // The stored key is later dereferenced by the download route, so it must
  // name a file this session actually uploaded — otherwise a student could
  // point their own answer at any stored file and have it served to them.
  if (
    content.type === "FILE_UPLOAD" &&
    !fileKeyBelongsTo(content.fileKey, id, questionId)
  ) {
    return validationError("Datei gehört nicht zu dieser Sitzung")
  }

  let answer
  try {
    answer = await prisma.$transaction(async (tx) => {
      // Re-check status inside the transaction so a concurrent lock (which
      // also writes via a gated updateMany) can't be missed by a stale read.
      const gate = await tx.examSession.updateMany({
        where: { id, status: { in: OPEN_STATUSES } },
        data: { lastSeenAt: new Date() },
      })
      if (gate.count === 0)
        throw new ApiError(409, "CONFLICT", "Sitzung ist nicht aktiv")

      // Raw SQL because the ordering guard needs ON CONFLICT ... WHERE: only
      // replace a stored answer whose clientSeq is lower, so this write and
      // the ws-backend flusher (same predicate, internal/store/store.go)
      // can't overwrite a newer save with an older one. A save without a
      // seq comes from a client that predates the field and writes
      // unconditionally, as before. Timestamps are UTC wall clock, matching
      // how Prisma stores DateTime in these TIMESTAMP(3) columns; a bare
      // now() would follow the server's TimeZone setting instead.
      const [written] = await tx.$queryRaw<
        { version: number; updatedAt: Date }[]
      >`
        INSERT INTO "Answer" (id, "sessionId", "questionId", content, version, "clientSeq", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${id}, ${questionId}, ${JSON.stringify(content)}::jsonb, 1, ${clientSeq ?? null}::float8, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
        ON CONFLICT ("sessionId", "questionId") DO UPDATE
        SET content = EXCLUDED.content,
            version = "Answer".version + 1,
            "clientSeq" = COALESCE(EXCLUDED."clientSeq", "Answer"."clientSeq"),
            "updatedAt" = now() AT TIME ZONE 'UTC'
        WHERE EXCLUDED."clientSeq" IS NULL
           OR "Answer"."clientSeq" IS NULL
           OR "Answer"."clientSeq" < EXCLUDED."clientSeq"
        RETURNING version, "updatedAt"
      `
      if (written) return { ...written, superseded: false }

      // No row came back: a save with a higher seq is already stored. This
      // save is obsolete, not failed, so the client should stop retrying it.
      const current = await tx.answer.findUniqueOrThrow({
        where: { sessionId_questionId: { sessionId: id, questionId } },
        select: { version: true, updatedAt: true },
      })
      return { ...current, superseded: true }
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    throw e
  }

  return NextResponse.json({
    saved: true,
    version: answer.version,
    savedAt: answer.updatedAt,
    superseded: answer.superseded,
  })
}
