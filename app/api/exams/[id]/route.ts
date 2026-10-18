import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { sebSettingsLockViolation, SEB_LOCKED_FIELDS } from "@/lib/seb-config"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import { updateExamSchema } from "@/lib/validators/exam"
import type { Prisma } from "@/generated/prisma/client"
import {
  ApiError,
  conflict,
  notFound,
  validationError,
} from "@/lib/api-response"
import {
  EDITABLE_EXAM_STATUSES,
  lockEditableExamForQuestionMutation,
} from "@/lib/exam-question-mutation"

type Params = { params: Promise<{ id: string }> }
type ExamPatchGuardState = {
  creatorId: string
  status: string
  sebConfigKey: string | null
  sebRequired: boolean
  allowSpellCheck: boolean
  scheduledStart: Date | null
  scheduledEnd: Date | null
  waitingRoom: boolean
}

function hasInvalidSchedule(
  exam: Pick<ExamPatchGuardState, "scheduledStart" | "scheduledEnd">,
  patch: { scheduledStart?: string | null; scheduledEnd?: string | null }
) {
  const merged = (stored: Date | null, next?: string | null) =>
    next === undefined ? stored : next === null ? null : new Date(next)
  const scheduledStart = merged(exam.scheduledStart, patch.scheduledStart)
  const scheduledEnd = merged(exam.scheduledEnd, patch.scheduledEnd)

  return Boolean(
    scheduledStart &&
    scheduledEnd &&
    scheduledEnd.getTime() <= scheduledStart.getTime()
  )
}

/**
 * A shared-start exam has no scheduled end (lib/exam-schedule.ts
 * scheduledEndCap). Checked on the merged state, like hasInvalidSchedule:
 * the schema's refine only sees the fields one PATCH sends, so
 * `{ waitingRoom: true }` over a stored end, or an end over a stored waiting
 * room, would persist a pair the UI hides, and switching the room off later
 * would bring a stale end back to life.
 */
function hasEndWithWaitingRoom(
  exam: Pick<ExamPatchGuardState, "scheduledEnd" | "waitingRoom">,
  patch: { scheduledEnd?: string | null; waitingRoom?: boolean }
) {
  const waitingRoom = patch.waitingRoom ?? exam.waitingRoom
  const scheduledEnd =
    patch.scheduledEnd === undefined ? exam.scheduledEnd : patch.scheduledEnd
  return waitingRoom && Boolean(scheduledEnd)
}

const END_WITH_WAITING_ROOM_MESSAGE =
  "Mit gemeinsamem Start gibt es kein geplantes Ende: Bitte zuerst das geplante Ende entfernen."

async function getOwnedExam(examId: string, userId: string) {
  const exam = await prisma.exam.findUnique({ where: { id: examId } })
  if (!exam) return null
  if (exam.creatorId !== userId) return null
  return exam
}

export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await getOwnedExam(id, session.user.id)
  if (!exam) return notFound("Prüfung nicht gefunden")

  const questions = await prisma.question.findMany({
    where: { examId: id },
    orderBy: { order: "asc" },
  })

  // The editor never needs the SEB secrets; keep them out of API responses
  // entirely (the quit password is also encrypted at rest now). Setting them
  // to undefined makes JSON.stringify drop the keys from the payload.
  return NextResponse.json({
    exam: {
      ...exam,
      sebQuitPassword: undefined,
      sebConfigKey: undefined,
      sebExamKeySalt: undefined,
    },
    questions,
  })
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await getOwnedExam(id, session.user.id)
  if (!exam) return notFound("Prüfung nicht gefunden")
  if (exam.status !== "DRAFT" && exam.status !== "PUBLISHED") {
    return conflict("Aktive Prüfungen können nicht bearbeitet werden")
  }

  const body = await readBoundedJson(request, BODY_LIMITS.MEDIUM)
  if (body instanceof NextResponse) return body
  const parsed = updateExamSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }
  const patchValues = parsed.data as Record<string, unknown>

  // Once the Config Key is frozen, changed SEB-relevant values are baked into
  // every .seb file already handed out. Repeating the persisted value is a
  // no-op and remains safe.
  const lockedField = sebSettingsLockViolation(exam, patchValues)
  if (lockedField) {
    return conflict(
      `Diese Einstellung (${lockedField}) ist gesperrt: Die SEB-Konfiguration wurde bereits an Studierende ausgegeben und kann nicht mehr geändert werden.`
    )
  }

  const currentScheduleInvalid = hasInvalidSchedule(exam, parsed.data)
  if (currentScheduleInvalid) {
    return validationError(
      "Geplantes Ende muss nach dem geplanten Start liegen"
    )
  }
  if (hasEndWithWaitingRoom(exam, parsed.data)) {
    return validationError(END_WITH_WAITING_ROOM_MESSAGE)
  }

  const writeWhere = (current: ExamPatchGuardState) => {
    const changesSebLockedValue = SEB_LOCKED_FIELDS.some(
      (field) => field in patchValues && patchValues[field] !== current[field]
    )

    return {
      id,
      creatorId: session.user.id,
      status: { in: [...EDITABLE_EXAM_STATUSES] },
      // Recheck the persisted values used for merged schedule validation and
      // SEB comparisons. This keeps concurrent partial edits from composing
      // into an invalid schedule or bypassing the frozen-key check.
      scheduledStart: current.scheduledStart,
      scheduledEnd: current.scheduledEnd,
      waitingRoom: current.waitingRoom,
      sebRequired: current.sebRequired,
      allowSpellCheck: current.allowSpellCheck,
      ...(changesSebLockedValue ? { sebConfigKey: null } : {}),
    }
  }

  const guardState = (current: ExamPatchGuardState) => ({
    id,
    creatorId: current.creatorId,
    status: current.status,
    sebConfigKey: current.sebConfigKey,
    sebRequired: current.sebRequired,
    allowSpellCheck: current.allowSpellCheck,
    scheduledStart: current.scheduledStart,
    scheduledEnd: current.scheduledEnd,
    waitingRoom: current.waitingRoom,
  })

  const persistPatch = async (db: Prisma.TransactionClient) => {
    let { count } = await db.exam.updateMany({
      where: writeWhere(exam),
      data: parsed.data,
    })

    if (count === 0) {
      const current = await db.exam.findUnique({
        where: { id },
        select: {
          id: true,
          creatorId: true,
          status: true,
          sebConfigKey: true,
          sebRequired: true,
          allowSpellCheck: true,
          scheduledStart: true,
          scheduledEnd: true,
          waitingRoom: true,
        },
      })
      if (!current || current.creatorId !== session.user.id) {
        return notFound("Prüfung nicht gefunden")
      }
      if (current.status !== "DRAFT" && current.status !== "PUBLISHED") {
        return conflict("Aktive Prüfungen können nicht bearbeitet werden")
      }
      const racedField = sebSettingsLockViolation(current, patchValues)
      if (racedField) {
        return conflict(
          `Diese Einstellung (${racedField}) ist gesperrt: Die SEB-Konfiguration wurde bereits an Studierende ausgegeben und kann nicht mehr geändert werden.`
        )
      }
      if (hasInvalidSchedule(current, parsed.data)) {
        return validationError(
          "Geplantes Ende muss nach dem geplanten Start liegen"
        )
      }
      if (hasEndWithWaitingRoom(current, parsed.data)) {
        return validationError(END_WITH_WAITING_ROOM_MESSAGE)
      }

      // The guarded write may have lost only because a concurrent edit or
      // activation changed one of the compared values. Re-evaluate once from
      // the persisted row; a second miss is a real concurrent modification.
      count = (
        await db.exam.updateMany({
          where: writeWhere(guardState(current)),
          data: parsed.data,
        })
      ).count
      if (count === 0) {
        return conflict(
          "Die Prüfung wurde gleichzeitig geändert. Bitte erneut laden."
        )
      }
    }

    const updated = await db.exam.findUnique({ where: { id } })
    if (!updated) {
      return notFound("Prüfung nicht gefunden")
    }

    return updated
  }

  let updated
  try {
    updated =
      // Under the exam-row lock whenever the patch carries a flag that people
      // in the waiting room depend on: waiting-room joins hold the same row
      // FOR SHARE, so the WAITING count below cannot miss a join committing
      // alongside this edit.
      parsed.data.sebRequired !== undefined ||
      parsed.data.waitingRoom !== undefined
        ? await prisma.$transaction(async (tx) => {
            // Use the same parent lock as question inserts. Check uploads in
            // a fresh statement after acquiring it, before enabling SEB.
            const locked = await lockEditableExamForQuestionMutation(
              tx,
              id,
              session.user.id,
              "Aktive Prüfungen können nicht bearbeitet werden"
            )
            const { waitingRoom } = await tx.exam.findUniqueOrThrow({
              where: { id },
              select: { waitingRoom: true },
            })
            // Turning the room off would strand everyone in it (new joins
            // skip it, SEB launches from it stop qualifying); switching SEB
            // would leave them waiting outside it (or inside it for nothing)
            // and cost the whole cohort exam time on the way to /take.
            const disablesRoom =
              waitingRoom && parsed.data.waitingRoom === false
            const changesSeb =
              parsed.data.sebRequired !== undefined &&
              parsed.data.sebRequired !== locked.sebRequired
            if (
              (disablesRoom || changesSeb) &&
              (await tx.examSession.count({
                where: { examId: id, status: "WAITING" },
              })) > 0
            ) {
              throw new ApiError(
                409,
                "CONFLICT",
                disablesRoom
                  ? "Der gemeinsame Start kann nicht mehr ausgeschaltet werden: Es warten bereits Teilnehmende im Warteraum."
                  : "Safe Exam Browser kann nicht mehr geändert werden: Es warten bereits Teilnehmende im Warteraum."
              )
            }
            // Only the off→on transition is guarded. Autosave resends
            // sebRequired: true with every edit, so checking it on an exam
            // that already requires SEB would block unrelated edits (title,
            // schedule) on legacy exams that still contain uploads.
            if (
              parsed.data.sebRequired === true &&
              !locked.sebRequired &&
              (await tx.question.count({
                where: { examId: id, type: "FILE_UPLOAD" },
              })) > 0
            ) {
              throw new ApiError(
                422,
                "VALIDATION_ERROR",
                SEB_FILE_UPLOAD_MESSAGE
              )
            }
            return persistPatch(tx)
          })
        : await persistPatch(prisma)
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }
  if (updated instanceof NextResponse) return updated

  await createAuditLog({
    action: "EXAM_UPDATED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    metadata: parsed.data,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await getOwnedExam(id, session.user.id)
  if (!exam) return notFound("Prüfung nicht gefunden")
  if (exam.status !== "DRAFT") {
    return conflict("Nur Entwürfe können gelöscht werden")
  }

  const { count } = await prisma.exam.deleteMany({
    where: { id, creatorId: session.user.id, status: "DRAFT" },
  })
  if (count === 0) return conflict("Nur Entwürfe können gelöscht werden")

  await createAuditLog({
    action: "EXAM_DELETED",
    entityType: "Exam",
    entityId: id,
    // No examId on purpose: AuditLog.examId is a foreign key to Exam, and the
    // row is gone — the insert would fail the FK and createAuditLog would
    // swallow the error, silently losing the EXAM_DELETED record. The ID is
    // kept in entityId (and in the audit trail's action/entity columns).
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return new NextResponse(null, { status: 204 })
}
