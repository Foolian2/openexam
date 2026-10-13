import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { requireStudent } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { verifyOrigin } from "@/lib/csrf"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { joinExamSchema } from "@/lib/validators/session"
import { computeEffectiveEndTime } from "@/lib/exam-session"
import {
  scheduleGate,
  clampToSchedule,
  scheduledEndCap,
  waitingRoomOpen,
} from "@/lib/exam-schedule"
import { formatDateTime } from "@/lib/format-date"
import {
  isOpen,
  isSubmitted,
  isWaiting,
  OPEN_STATUSES,
} from "@/lib/session-state"
import { reserveAdmission } from "@/lib/exam-admission"
import {
  ApiError,
  apiError,
  conflict,
  forbidden,
  notFound,
  rateLimited,
  validationError,
} from "@/lib/api-response"

/**
 * List the caller's exam sessions with exam metadata. Students get their own
 * sessions; teachers/admins get 403 (they use /api/exams/[id]/sessions).
 * No SEB guard — this returns only metadata, never questions or answers.
 */
export async function GET(request: NextRequest) {
  const authed = await requireStudent(request, "Nur Schüler haben Sitzungen")
  if (authed instanceof NextResponse) return authed
  const session = authed

  const limit = await rateLimit(`list-sessions:${session.user.id}`, 60, 60)
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const sessions = await prisma.examSession.findMany({
    where: { userId: session.user.id },
    include: {
      exam: {
        select: {
          id: true,
          title: true,
          timeLimitMin: true,
          sebRequired: true,
          status: true,
        },
      },
    },
    orderBy: { startedAt: "desc" },
    take: 50,
  })

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      submittedAt: s.submittedAt,
      effectiveEndTime: s.effectiveEndTime,
      timeExtensionMin: s.timeExtensionMin,
      reconnectCount: s.reconnectCount,
      exam: {
        id: s.exam.id,
        title: s.exam.title,
        timeLimitMin: s.exam.timeLimitMin,
        sebRequired: s.exam.sebRequired,
        status: s.exam.status,
      },
    })),
  })
}

/**
 * Join an exam via access code. Creates (or resumes) the caller's ExamSession
 * and starts the clock on first entry.
 *
 * A shared-start exam (`waitingRoom`) that is still PUBLISHED instead puts the
 * student in its waiting room: a WAITING session without a clock, answered
 * with `waiting: true`. The teacher's Start (the activate route) starts every
 * waiting clock at once; joins after that are ordinary late joins with the
 * full time limit.
 */
export async function POST(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStudent(
    request,
    "Nur Schüler können an Prüfungen teilnehmen"
  )
  if (authed instanceof NextResponse) return authed
  const session = authed

  // Throttle code guessing. No captcha gate here (unlike sign-up/sign-in):
  // the access code space (32^6 ≈ 1.07B) plus this per-account cap plus
  // requiring a real STUDENT account (itself gated by Cap at sign-up) is
  // enough — and this is the highest-frequency, most time-sensitive request
  // in the app, so captcha flakiness here risks locking students out of
  // their own exam.
  //
  // Fail-closed on a Redis outage: unbounded code guessing during an outage
  // is worse than briefly refusing joins (rate-limit.ts documents access-code
  // brute force as the canonical fail-closed case).
  const limit = await rateLimit(
    `join-exam:${session.user.id}`,
    10,
    60,
    "closed"
  )
  if (!limit.allowed) {
    return rateLimited(
      limit.resetInSeconds,
      "Zu viele Versuche. Bitte später erneut versuchen."
    )
  }

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = joinExamSchema.safeParse(body)
  if (!parsed.success) {
    return validationError("Ungültiger Zugangscode")
  }

  const exam = await prisma.exam.findUnique({
    where: { accessCode: parsed.data.accessCode },
  })
  const now = new Date()
  const waitingRoom = exam ? waitingRoomOpen(exam, now) : false
  if (
    exam &&
    exam.status === "PUBLISHED" &&
    exam.waitingRoom &&
    !waitingRoom &&
    exam.scheduledStart
  ) {
    // The same code a scheduled ACTIVE exam answers before its start, so the
    // join form's handling and what a code reveals stay unchanged.
    return apiError(
      "NOT_STARTED",
      `Der Warteraum öffnet am ${formatDateTime(exam.scheduledStart)}.`,
      403
    )
  }
  if (!exam || (exam.status !== "ACTIVE" && !waitingRoom)) {
    // Same response for "unknown code" and "not active" so codes can't be probed.
    return notFound("Keine aktive Prüfung mit diesem Zugangscode gefunden")
  }

  const existing = await prisma.examSession.findUnique({
    where: { examId_userId: { examId: exam.id, userId: session.user.id } },
  })

  if (existing && isSubmitted(existing.status)) {
    return conflict("Prüfung wurde bereits abgegeben")
  }
  if (existing && existing.status === "LOCKED") {
    return forbidden("Sitzung wurde von der Lehrperson gesperrt")
  }

  if (waitingRoom) {
    return joinWaitingRoom(request, exam, session.user.id, existing, now)
  }

  // Enforce the join window. An existing session (resume/reconnect) always
  // passes — its personal deadline governs, and the take page / autosave /
  // submit paths all require an existing session, so this gate is the single
  // choke point for the schedule.
  const gate = scheduleGate(exam, now, { existingSession: existing !== null })
  if (!gate.ok) {
    // Returned, not thrown: the ApiError catch below only wraps the
    // transaction, so throwing here escaped the handler as a bodyless 500 and
    // the join form had no error code to render. The two guards above return
    // directly for the same reason.
    return apiError(
      gate.reason === "not_started" ? "NOT_STARTED" : "EXAM_ENDED",
      gate.reason === "not_started"
        ? "Die Prüfung hat noch nicht begonnen."
        : "Die Prüfung ist bereits beendet.",
      403
    )
  }

  // Stagger first-time entries so a whole class pressing "Teilnehmen" at once
  // doesn't arrive as one burst (lib/exam-admission.ts). This sits after the
  // guards above so a locked, finished or not-yet-open exam still says so
  // immediately instead of after a pointless wait, and before the write below
  // so the queue costs two indexed reads rather than a transaction, an audit
  // row, the take-page SSR and the full question payload.
  //
  // Resumes skip the queue: their exam clock is already running, so a hold
  // would come out of their own writing time.
  if (!existing) {
    const { waitMs } = await reserveAdmission({
      examId: exam.id,
      userId: session.user.id,
    })
    if (waitMs > 0) {
      // 202, not 429: nothing went wrong and there is nothing to retry
      // differently — the place in line is already reserved and the client is
      // being told when to take it. Retry-After is the whole-second form for
      // any proxy or non-browser client that reads it; browsers follow
      // `waitMs`, which keeps the sub-second precision the schedule needs to
      // actually spread a cohort.
      return NextResponse.json(
        { queued: true, waitMs, examId: exam.id },
        {
          status: 202,
          headers: { "Retry-After": String(Math.ceil(waitMs / 1000)) },
        }
      )
    }
  }

  let examSession
  try {
    examSession = await prisma.$transaction(async (tx) => {
      if (existing && isWaiting(existing.status)) {
        // Still WAITING under an ACTIVE exam: Start converts every waiting
        // session in its own transaction, so this only happens if a waiting
        // join raced it. Treat it as a late join rather than refusing it.
        await tx.examSession.updateMany({
          where: { id: existing.id, status: "WAITING" },
          data: {
            status: "IN_PROGRESS",
            startedAt: now,
            effectiveEndTime: clampToSchedule(
              computeEffectiveEndTime(
                now,
                exam.timeLimitMin,
                existing.timeExtensionMin
              ),
              scheduledEndCap(exam)
            ),
            lastSeenAt: now,
          },
        })
        return tx.examSession.findUniqueOrThrow({ where: { id: existing.id } })
      }
      if (existing) {
        // Gate the update on the live status: closes the window between the
        // read above and this write — e.g. a teacher lock, or a submit
        // landing in between. A negative match on LOCKED alone also matched
        // SUBMITTED/AUTO_SUBMITTED, letting a resume racing a concurrent
        // submit flip the session back to IN_PROGRESS and reopen answer
        // mutation after grading; the positive allowlist (matching the
        // submit/autosave routes' own gates) makes submitted terminal.
        const gate = await tx.examSession.updateMany({
          where: { id: existing.id, status: { in: OPEN_STATUSES } },
          data: {
            status: "IN_PROGRESS",
            startedAt: existing.startedAt ?? now,
            lastSeenAt: now,
            ...(isOpen(existing.status)
              ? { reconnectCount: { increment: 1 } }
              : {}),
          },
        })
        if (gate.count === 0) {
          throw new ApiError(
            403,
            "FORBIDDEN",
            "Sitzung wurde von der Lehrperson gesperrt"
          )
        }
        // The persisted deadline includes explicit teacher grants and is the
        // authority on resume. Recomputing/clamping here discarded those
        // grants, and writing a pre-read deadline could undo a concurrent
        // extension. The update above holds the row lock before this read.
        const resumed = await tx.examSession.findUniqueOrThrow({
          where: { id: existing.id },
        })
        if (resumed.effectiveEndTime) return resumed
        // Backfill only legacy/pre-start rows without a deadline, using the
        // settled extension count while holding the same transaction lock.
        return tx.examSession.update({
          where: { id: resumed.id },
          data: {
            effectiveEndTime: clampToSchedule(
              computeEffectiveEndTime(
                resumed.startedAt ?? now,
                exam.timeLimitMin,
                resumed.timeExtensionMin
              ),
              scheduledEndCap(exam)
            ),
          },
        })
      }
      // upsert (not create): guards against two simultaneous first-time joins
      // racing on the unique (examId, userId) constraint. A session can't be
      // LOCKED before it exists, so a no-op update on conflict is safe here.
      return tx.examSession.upsert({
        where: { examId_userId: { examId: exam.id, userId: session.user.id } },
        create: {
          examId: exam.id,
          userId: session.user.id,
          status: "IN_PROGRESS",
          startedAt: now,
          effectiveEndTime: clampToSchedule(
            computeEffectiveEndTime(now, exam.timeLimitMin, 0),
            scheduledEndCap(exam)
          ),
          lastSeenAt: now,
        },
        update: {},
      })
    })
  } catch (e) {
    if (e instanceof ApiError) {
      return e.toResponse()
    }
    throw e
  }

  await createAuditLog({
    action: existing ? "SESSION_RESUMED" : "SESSION_STARTED",
    entityType: "ExamSession",
    entityId: examSession.id,
    examId: exam.id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json(
    {
      sessionId: examSession.id,
      examId: exam.id,
      exam: {
        title: exam.title,
        timeLimitMin: exam.timeLimitMin,
        sebRequired: exam.sebRequired,
      },
      resumed: existing ? true : false,
    },
    { status: existing ? 200 : 201 }
  )
}

type JoinableExam = NonNullable<
  Awaited<ReturnType<typeof prisma.exam.findUnique>>
>
type ExistingSession = Awaited<ReturnType<typeof prisma.examSession.findUnique>>

/**
 * Enter (or re-enter) the waiting room of a shared-start exam. The exam row
 * is read FOR SHARE so the join cannot interleave with Start (which locks it
 * FOR UPDATE): a waiting session created after Start's conversion would wait
 * forever under an ACTIVE exam. Joins among themselves still run in parallel.
 */
async function joinWaitingRoom(
  request: NextRequest,
  exam: JoinableExam,
  userId: string,
  existing: ExistingSession,
  now: Date
) {
  if (existing && !isWaiting(existing.status)) {
    // A started or finished session cannot exist under a PUBLISHED exam; the
    // guards above already answered submitted and locked ones.
    return conflict("Sitzung kann nicht betreten werden")
  }

  if (!existing) {
    // The same burst spreading as a normal first join: a whole class entering
    // the waiting room at the opening time is the same burst.
    const { waitMs } = await reserveAdmission({ examId: exam.id, userId })
    if (waitMs > 0) {
      return NextResponse.json(
        { queued: true, waitMs, examId: exam.id },
        {
          status: 202,
          headers: { "Retry-After": String(Math.ceil(waitMs / 1000)) },
        }
      )
    }
  }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        { status: string; waitingRoom: boolean }[]
      >`
        SELECT "status"::text AS "status", "waitingRoom" FROM "Exam"
        WHERE "id" = ${exam.id}
        FOR SHARE
      `
      if (locked?.status === "ACTIVE") {
        // Start won the race. This is now an ordinary late join.
        const session = await tx.examSession.upsert({
          where: { examId_userId: { examId: exam.id, userId } },
          create: {
            examId: exam.id,
            userId,
            status: "IN_PROGRESS",
            startedAt: now,
            effectiveEndTime: computeEffectiveEndTime(
              now,
              exam.timeLimitMin,
              0
            ),
            lastSeenAt: now,
          },
          update: {},
        })
        return { session, waiting: false }
      }
      // Revalidated under the lock: the teacher may have switched the room
      // off (the PATCH takes this row FOR UPDATE) since the read above.
      if (locked?.status !== "PUBLISHED" || !locked.waitingRoom) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          "Keine aktive Prüfung mit diesem Zugangscode gefunden"
        )
      }
      const session = await tx.examSession.upsert({
        where: { examId_userId: { examId: exam.id, userId } },
        create: {
          examId: exam.id,
          userId,
          status: "WAITING",
          lastSeenAt: now,
        },
        update: { lastSeenAt: now },
      })
      return { session, waiting: isWaiting(session.status) }
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }

  if (!existing) {
    await createAuditLog({
      action: result.waiting ? "SESSION_WAITING" : "SESSION_STARTED",
      entityType: "ExamSession",
      entityId: result.session.id,
      examId: exam.id,
      userId,
      ipAddress: getClientIp(request) ?? undefined,
    })
  }

  return NextResponse.json(
    {
      sessionId: result.session.id,
      examId: exam.id,
      exam: {
        title: exam.title,
        timeLimitMin: exam.timeLimitMin,
        sebRequired: exam.sebRequired,
      },
      resumed: existing ? true : false,
      waiting: result.waiting,
    },
    { status: existing ? 200 : 201 }
  )
}
