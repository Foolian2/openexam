import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { redis } from "@/lib/redis"
import { computeSebConfigKey } from "@/lib/seb-issuance"
import { ApiError } from "@/lib/api-response"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import { lockExamRow } from "@/lib/exam-question-mutation"
import { SHARED_START_LEAD_MS } from "@/lib/exam-schedule"
import { computeEffectiveEndTime } from "@/lib/exam-session"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const locked = await lockExamRow(tx, id)
      if (!locked || locked.creatorId !== session.user.id) {
        throw new ApiError(404, "NOT_FOUND", "Prüfung nicht gefunden")
      }
      if (locked.status !== "PUBLISHED") {
        throw new ApiError(
          409,
          "CONFLICT",
          "Nur veröffentlichte Prüfungen können aktiviert werden"
        )
      }

      // Question mutations acquire the same parent-row lock. Count while
      // holding it so deleting the final question cannot race activation.
      const questionCount = await tx.question.count({ where: { examId: id } })
      if (questionCount === 0) {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "Prüfung muss mindestens eine Frage enthalten"
        )
      }

      const exam = await tx.exam.findUniqueOrThrow({ where: { id } })

      // Also catch incompatible exams saved before uploads were blocked.
      if (
        exam.sebRequired &&
        (await tx.question.count({
          where: { examId: id, type: "FILE_UPLOAD" },
        })) > 0
      ) {
        throw new ApiError(422, "VALIDATION_ERROR", SEB_FILE_UPLOAD_MESSAGE)
      }

      // Persisted once here (settings can't change out from under a
      // distributed .seb file) so every consumer reads the same key.
      // Only compute when still null: a pre-activation download may already
      // have frozen the key from the same persisted secrets.
      let sebConfigKey: string | undefined
      if (exam.sebRequired && !exam.sebConfigKey) {
        sebConfigKey = await computeSebConfigKey(exam, undefined, tx)
      }

      // Keep the conditional key guard as defense against a concurrent
      // config download that froze the key before this row lock was acquired.
      const activatedAt = new Date()
      const { count } = await tx.exam.updateMany({
        where: {
          id,
          creatorId: session.user.id,
          status: "PUBLISHED",
          ...(sebConfigKey ? { sebConfigKey: null } : {}),
        },
        data: {
          status: "ACTIVE",
          activatedAt,
          ...(sebConfigKey && { sebConfigKey }),
        },
      })

      if (count === 0) {
        const current = await tx.exam.findUnique({
          where: { id },
          select: { status: true },
        })
        if (!current || current.status !== "PUBLISHED") {
          throw new ApiError(
            409,
            "CONFLICT",
            "Nur veröffentlichte Prüfungen können aktiviert werden"
          )
        }
        throw new ApiError(
          409,
          "CONFLICT",
          "Die SEB-Konfiguration wurde bereits heruntergeladen. Bitte erneut versuchen."
        )
      }

      // Start every waiting clock at the same instant, under the same row
      // lock waiting-room joins take FOR SHARE, so no WAITING session can be
      // created after this. Each deadline folds in that session's own
      // pre-start grants (timeExtensionMin, e.g. a Nachteilsausgleich given
      // in the waiting room), the same sum a normal join computes; grouping
      // by that value keeps it to one write per distinct grant.
      const sharedStart = new Date(activatedAt.getTime() + SHARED_START_LEAD_MS)
      // Lock the waiting rows first. A pre-start extension (the extend route
      // locks the session row too) committing between the grouping read
      // and its update would move a row out of the group it was read in,
      // so no update would match it and it would stay WAITING under an
      // ACTIVE exam. Once locked, no grant can change before the updates.
      await tx.$queryRaw`
        SELECT "id" FROM "ExamSession"
        WHERE "examId" = ${id} AND "status" = 'WAITING'
        FOR UPDATE
      `
      const grants = await tx.examSession.findMany({
        where: { examId: id, status: "WAITING" },
        distinct: ["timeExtensionMin"],
        select: { timeExtensionMin: true },
      })
      let startedWaiting = 0
      for (const { timeExtensionMin } of grants) {
        const { count: started } = await tx.examSession.updateMany({
          where: { examId: id, status: "WAITING", timeExtensionMin },
          data: {
            status: "IN_PROGRESS",
            startedAt: sharedStart,
            effectiveEndTime: computeEffectiveEndTime(
              sharedStart,
              exam.timeLimitMin,
              timeExtensionMin
            ),
          },
        })
        startedWaiting += started
      }

      return {
        exam: await tx.exam.findUniqueOrThrow({ where: { id } }),
        startedWaiting,
        // When the waiting clocks begin (after the visible countdown).
        startsAt: startedWaiting > 0 ? sharedStart : null,
      }
    })
  } catch (e) {
    if (e instanceof ApiError) return e.toResponse()
    throw e
  }
  const { exam: updated, startedWaiting, startsAt } = result

  try {
    await redis.publish(
      `exam:${id}:control`,
      JSON.stringify({ type: "EXAM_ACTIVATED" })
    )
  } catch {
    // Non-fatal: WebSocket server may not be running in dev
  }

  await createAuditLog({
    action: "EXAM_ACTIVATED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
    ...(updated.waitingRoom && {
      metadata: {
        waitingStudents: startedWaiting,
        startsAt: startsAt?.toISOString() ?? null,
      },
    }),
  })

  return NextResponse.json({ exam: updated, startedWaiting, startsAt })
}
