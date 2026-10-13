import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { conflict, notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** CLOSED → GRADED. Makes results visible to students when showResults is set. */
export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (exam.status !== "CLOSED") {
    return conflict(
      "Nur beendete Prüfungen können als bewertet markiert werden"
    )
  }

  await regradeFlaggedSessions({ examId: id })
  // Guarded write predicated on CLOSED: a concurrent archive (CLOSED→ARCHIVED)
  // must not be clobbered back to GRADED. If archive won the race this is a
  // no-op and we report the conflict instead of leaving status=GRADED with
  // archivedAt set.
  const { count } = await prisma.exam.updateMany({
    where: { id, status: "CLOSED" },
    data: { status: "GRADED" },
  })
  if (count === 0) {
    return conflict(
      "Nur beendete Prüfungen können als bewertet markiert werden"
    )
  }
  const updated = await prisma.exam.findUnique({ where: { id } })

  await createAuditLog({
    action: "EXAM_GRADED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}
