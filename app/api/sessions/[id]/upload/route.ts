import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { storeAnswerFile } from "@/lib/answer-files"
import { isOpen, pastDeadline } from "@/lib/session-state"
import { verifySebAccess } from "@/lib/seb-guard"
import { publicRequestUrl } from "@/lib/seb-urls"
import { buildFileKey, FILE_EXTENSION_RE } from "@/lib/answer-file-key"
import { rateLimit } from "@/lib/rate-limit"
import { redis } from "@/lib/redis"
import {
  computeUploadBudgetBytes,
  effectiveMaxFileSizeMB,
  UPLOAD_BUDGET_TTL_SECONDS,
} from "@/lib/upload-budget"
import { asTypedQuestion, type FileUploadConfig } from "@/lib/types/questions"
import {
  apiError,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  validationError,
} from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

// Upload churn is bounded by both a per-session rate limit and a per-session
// byte budget. Without either, a student in any active exam with a
// FILE_UPLOAD question could fill the database with orphaned files (the
// upload is stored even if the Answer row is never saved, and only the last
// key per question is referenced) or exhaust web-process memory with
// concurrent large bodies.
const UPLOAD_RATE_LIMIT = 10 // uploads per window
const UPLOAD_RATE_WINDOW_SECONDS = 300

// Per-session byte budget. INCRBY and the one-time EXPIRE run in a single
// atomic script: a crash between the two calls of the old two-step form
// left a TTL-less counter that never reset, permanently wedging the
// session's uploads at QUOTA_EXCEEDED. EXPIRE NX also self-heals keys left
// TTL-less by the old code, and never resets an existing window. The refund
// on the failure paths below keeps the counter honest.
const UPLOAD_BUDGET_SCRIPT = `
local total = redis.call("INCRBY", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2], "NX")
return total
`

/** Uploads a student's file for a FILE_UPLOAD question. Returns the file key to save via the answers endpoint. */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const limit = await rateLimit(
    `session-upload:${session.user.id}`,
    20,
    60,
    "closed"
  )
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
  if (!isOpen(examSession.status)) {
    return conflict("Sitzung ist nicht aktiv")
  }
  if (pastDeadline(examSession.effectiveEndTime)) {
    return conflict("Bearbeitungszeit ist abgelaufen")
  }

  // Fail-closed rate limit: over budget, refuse the request outright rather
  // than letting a Redis outage turn the limiter into a free pass.
  const rl = await rateLimit(
    `upload:${id}`,
    UPLOAD_RATE_LIMIT,
    UPLOAD_RATE_WINDOW_SECONDS,
    "closed"
  )
  if (!rl.allowed) {
    return apiError("RATE_LIMITED", "Zu viele Uploads. Bitte kurz warten.", 429)
  }

  const form = await request.formData().catch(() => null)
  const questionId = form?.get("questionId")
  const file = form?.get("file")
  if (typeof questionId !== "string" || !(file instanceof File)) {
    return validationError("Datei oder Frage fehlt")
  }

  const row = await prisma.question.findUnique({
    where: { id: questionId },
  })
  const question = row && asTypedQuestion(row)
  if (
    !question ||
    question.examId !== examSession.examId ||
    question.type !== "FILE_UPLOAD"
  ) {
    return notFound("Frage nicht gefunden")
  }

  // Re-checked at runtime anyway: this is the gate for what gets stored.
  const config: FileUploadConfig | null = question.config
  if (
    !config ||
    !Array.isArray(config.allowedExtensions) ||
    typeof config.maxFileSizeMB !== "number"
  ) {
    return apiError("VALIDATION_ERROR", "Ungültige Fragenkonfiguration", 400)
  }
  // The extension restricts the teacher's requested submission format, not
  // whether bytes are safe to execute. Arbitrary formats (including source
  // code and text with no magic number) are supported. Files stay opaque in
  // AnswerFile and every download uses downloadHeaders from
  // lib/answer-file-headers.ts: attachment, application/octet-stream and
  // nosniff. Never render or execute these bytes.
  // nosemgrep: openexam-file-upload-trusts-client-content-type
  const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "")
  // The extension is client-derived and ends up inside the file key, so pin
  // it to a plain lowercase-alphanumeric suffix. Without this a teacher config
  // allowing an extension containing "/" would let a filename inject extra path
  // segments into the key and escape the session prefix everything else checks.
  if (!FILE_EXTENSION_RE.test(ext) || !config.allowedExtensions.includes(ext)) {
    return validationError(
      `Dateityp nicht erlaubt. Erlaubt: ${config.allowedExtensions.join(", ")}`
    )
  }
  const maxMB = effectiveMaxFileSizeMB(config)
  if (file.size > maxMB * 1024 * 1024) {
    return validationError(`Datei zu gross. Maximum: ${maxMB} MB`)
  }

  const uploadQuestions = await prisma.question.findMany({
    where: { examId: examSession.examId, type: "FILE_UPLOAD" },
    select: { type: true, config: true },
  })
  const budgetBytes = computeUploadBudgetBytes(
    uploadQuestions
      .map(asTypedQuestion)
      .flatMap((q) => (q.type === "FILE_UPLOAD" ? [q.config] : []))
  )

  const budgetKey = `uploads:bytes:${id}`
  const totalBytes = Number(
    await redis.eval(
      UPLOAD_BUDGET_SCRIPT,
      1,
      budgetKey,
      file.size,
      UPLOAD_BUDGET_TTL_SECONDS
    )
  )
  if (totalBytes > budgetBytes) {
    await redis.decrby(budgetKey, file.size)
    return apiError(
      "QUOTA_EXCEEDED",
      "Upload-Budget für diese Prüfung aufgebraucht",
      429
    )
  }
  const fileKey = buildFileKey(id, questionId, randomUUID(), ext)
  // Memory note: request.formData() has already buffered the whole multipart
  // body, and this arrayBuffer() adds a second copy. The ceiling is bounded by
  // the per-file cap (MAX_UPLOAD_MB, 25 MB) — so peak is ~2x the file size
  // per concurrent upload, plus the copy handed to Postgres. Acceptable
  // for a school classroom; a streaming (busboy) rewrite would only pay off
  // under many concurrent large uploads.
  const bytes = Buffer.from(await file.arrayBuffer())

  // Durable backstop: the Redis counter above expires after 48 h and is lost
  // on a Redis flush, but the bytes it guards live on in Postgres. Count what
  // this session actually stores and insert under a per-session advisory
  // lock, so two concurrent uploads can't both pass the same stale total.
  // An advisory lock rather than a row lock: the ExamSession row is what the
  // WS flusher locks, and a 25 MB insert must not hold up answer flushes.
  let stored: boolean
  try {
    stored = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`answer-upload:${id}`}, 0))`
        const [row] = await tx.$queryRaw<{ bytes: bigint | null }[]>`
          SELECT SUM("sizeBytes")::bigint AS bytes FROM "AnswerFile" WHERE "sessionId" = ${id}
        `
        if (Number(row?.bytes ?? 0) + file.size > budgetBytes) return false
        await storeAnswerFile(fileKey, id, questionId, bytes, tx)
        return true
      },
      { timeout: 30_000 }
    )
  } catch (err) {
    await redis.decrby(budgetKey, file.size)
    throw err
  }
  if (!stored) {
    await redis.decrby(budgetKey, file.size)
    return apiError(
      "QUOTA_EXCEEDED",
      "Upload-Budget für diese Prüfung aufgebraucht",
      429
    )
  }

  // Upload only stages bytes; the answers endpoint/WS autosave commits the
  // answer pointer separately. The old referenced file must survive a failed,
  // offline, or sequence-superseded autosave and concurrent replacement uploads,
  // so nothing is deleted here. Superseded files are pruned only after the
  // session is submitted and settled: lib/answer-file-retention.ts.

  return NextResponse.json({ fileKey, fileName: file.name })
}
