import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireStaff } from "@/lib/api-auth"
import { notFound, validationError } from "@/lib/api-response"
import { BODY_LIMITS, readBoundedJson } from "@/lib/body-size"
import { gradeSessions } from "@/lib/finalize-session"
import { prisma } from "@/lib/prisma"
import { SUBMITTED_STATUSES } from "@/lib/session-state"

type Params = { params: Promise<{ id: string }> }

const ensureGradedSchema = z.object({
  sessionId: z.string().cuid().optional(),
})

/**
 * Grading safety net: a crash between a session's submit commit and its
 * grade call can leave it submitted with no grades at all, and nothing else
 * retries it. The same goes for a session flagged needsRegrade, whose
 * grades predate a late-flushed answer. The grading views call this before
 * loading, so the teacher never marks against missing or stale auto-grades.
 *
 * It used to run inside the grading GETs themselves; a GET that writes can
 * be prefetched or retried by anything in between, so the write is its own
 * explicit request now and the GETs only read.
 *
 * gradeSessions applies the submit/close retry policy, never throws, and is
 * idempotent (Grade is unique per session+question, manual grades are never
 * touched), so calling this speculatively is safe.
 */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = ensureGradedSchema.safeParse(body ?? {})
  if (!parsed.success) return validationError("Ungültige Anfrage")

  const { id } = await params
  const exam = await prisma.exam.findUnique({
    where: { id },
    select: { creatorId: true, _count: { select: { questions: true } } },
  })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  // An exam without questions legitimately produces no grades.
  if (exam._count.questions === 0) return NextResponse.json({ graded: 0 })

  const ungraded = await prisma.examSession.findMany({
    where: {
      examId: id,
      status: { in: SUBMITTED_STATUSES },
      // needsRegrade: an answer acked before the submit only reached
      // Postgres after grading ran, so the existing grades are stale.
      OR: [{ grades: { none: {} } }, { needsRegrade: true }],
      ...(parsed.data.sessionId ? { id: parsed.data.sessionId } : {}),
    },
    select: { id: true },
  })
  const ids = ungraded.map((s) => s.id)
  if (ids.length > 0) await gradeSessions(ids)

  return NextResponse.json({ graded: ids.length })
}
