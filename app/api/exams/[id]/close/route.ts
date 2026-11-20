import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { Prisma } from "@/generated/prisma/client"
import { getClientIp } from "@/lib/client-ip"
import { finalizeSession } from "@/lib/finalize-session"
import { ACTIVE_STATUSES } from "@/lib/session-state"
import { ApiError, notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** Closes an active exam and force-submits every live session (in progress
 * OR locked). LOCKED sessions must be finalized too: left behind they stay
 * LOCKED forever in a CLOSED exam — never graded, never exported, and
 * re-openable by an unlock that then writes to a closed exam. */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  const now = new Date()
  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // Gate the close on the live status so two concurrent close requests
      // can't both force-submit sessions and both write an audit entry.
      const gate = await tx.exam.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "CLOSED", closedAt: now },
      })
      if (gate.count === 0) {
        throw new ApiError(
          409,
          "CONFLICT",
          "Nur aktive Prüfungen können beendet werden"
        )
      }
      // Claim and return only rows this UPDATE actually changed. A concurrent
      // submit or deadline sweep can win the row first; the status predicate
      // is rechecked after any row-lock wait, so close never overwrites that
      // terminal submission or finalizes the same session twice.
      //
      // Order is load-bearing: this claim must stay AFTER the exam-status
      // UPDATE above. joinActiveExam (lib/join-active-exam.ts) holds the exam
      // row FOR SHARE through its INSERT, so the UPDATE serializes behind an
      // admitted join; claiming first would run on a snapshot where that
      // session is not committed yet and silently miss it. Do not reorder.
      //
      // The pending marker commits with the claim: if this process dies
      // before finalization finishes, the deadline sweeper picks the rows up.
      const forcedSessions = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "ExamSession"
        SET "status" = 'AUTO_SUBMITTED',
            "submissionType" = 'TEACHER_FORCED',
            "submittedAt" = ${now},
            "deadlineFinalizationPending" = true
        WHERE "examId" = ${id}
          AND "status"::text IN (${Prisma.join(ACTIVE_STATUSES)})
        RETURNING "id"
      `)
      // Commit the exam-level event with the close itself. Session recovery
      // retries SESSION_SUBMITTED, so it cannot reconstruct this event after
      // a process dies before post-commit finalization (including empty exams).
      // The finalizer uses the same key and leaves this durable row untouched.
      await tx.auditLog.createMany({
        data: [
          {
            action: "EXAM_CLOSED",
            entityType: "Exam",
            entityId: id,
            examId: id,
            userId: session.user.id,
            metadata: { forcedSubmissions: forcedSessions.length },
            ipAddress: getClientIp(request) ?? undefined,
            idempotencyKey: `EXAM_CLOSED:${id}`,
          },
        ],
        skipDuplicates: true,
      })
      const updatedExam = await tx.exam.findUniqueOrThrow({ where: { id } })
      return {
        forcedSessionIds: forcedSessions.map((s) => s.id),
        updatedExam,
      }
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    throw e
  }
  const { forcedSessionIds, updatedExam } = result

  // Grade after the transaction commits; grading is idempotent per session,
  // batched so a large class doesn't exhaust the database connection pool.
  // finalizeSession grades (gradeWithRetry absorbs transient failures and
  // never throws, so a grading hiccup can't fail the close response after
  // the sessions are force-submitted), publishes the control message, then
  // writes the audit log.
  await finalizeSession({
    examId: id,
    sessionIds: forcedSessionIds,
    control: { type: "EXAM_CLOSED" },
    // Stable per exam: ACTIVE -> CLOSED happens at most once (the status gate
    // above), so a retry of this finalization reuses the key and is deduped.
    dedupeKey: `EXAM_CLOSED:${id}`,
    audit: {
      action: "EXAM_CLOSED",
      entityType: "Exam",
      entityId: id,
      examId: id,
      userId: session.user.id,
      metadata: { forcedSubmissions: forcedSessionIds.length },
      ipAddress: getClientIp(request) ?? undefined,
    },
  })
  if (forcedSessionIds.length > 0) {
    await prisma.examSession.updateMany({
      where: {
        id: { in: forcedSessionIds },
        deadlineFinalizationPending: true,
      },
      data: { deadlineFinalizationPending: false },
    })
  }

  return NextResponse.json({
    exam: updatedExam,
    forcedSubmissions: forcedSessionIds.length,
  })
}
