import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { z } from "zod"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { conflict, notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

const bodySchema = z.object({ showResults: z.boolean() })

/**
 * Toggles result visibility for exams that are otherwise locked from editing.
 * The main PATCH /api/exams/[id] route rejects any change once an exam leaves
 * DRAFT/PUBLISHED, but showResults legitimately needs to change after grading.
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (
    exam.status !== "CLOSED" &&
    exam.status !== "GRADED" &&
    exam.status !== "ARCHIVED"
  ) {
    return conflict(
      "Ergebnis-Sichtbarkeit kann nur für beendete Prüfungen hier geändert werden"
    )
  }

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  if (parsed.data.showResults) await regradeFlaggedSessions({ examId: id })
  const updated = await prisma.exam.update({
    where: { id },
    data: { showResults: parsed.data.showResults },
  })

  await createAuditLog({
    action: "EXAM_UPDATED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    metadata: { showResults: parsed.data.showResults },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}
