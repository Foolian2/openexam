import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { getClientIp } from "@/lib/client-ip"
import { bulkGradeSchema } from "@/lib/validators/grade"
import { applyBulkGrade } from "@/lib/grading/bulk-grade"
import { conflict, notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** Applies a bulk grading action across multiple submitted sessions of one exam. */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const body = await readBoundedJson(request, BODY_LIMITS.SMALL)
  if (body instanceof NextResponse) return body
  const parsed = bulkGradeSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const { sessionIds, ...action } = parsed.data
  const result = await applyBulkGrade({
    examId: id,
    teacherId: session.user.id,
    sessionIds,
    action,
    ipAddress: getClientIp(request) ?? undefined,
  })

  if (!result.ok) {
    if (result.reason === "not_found") {
      return notFound("Prüfung nicht gefunden")
    }
    if (result.reason === "question_not_found") {
      return notFound("Frage nicht gefunden")
    }
    if (result.reason === "invalid_points") {
      return validationError("Punkte überschreiten das Maximum")
    }
    return conflict("Massenbewertung nur für beendete Prüfungen möglich")
  }

  return NextResponse.json({
    sessionsAffected: result.sessionsAffected,
    gradesCreated: result.gradesCreated,
    gradesUpdated: result.gradesUpdated,
  })
}
