import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { conflict, notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { _count: { select: { questions: true } } },
  })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (exam.status !== "DRAFT") {
    return conflict("Nur Entwürfe können veröffentlicht werden")
  }
  if (exam._count.questions === 0) {
    return validationError("Prüfung muss mindestens eine Frage enthalten")
  }

  // Guarded write: the status check above read a stale row, so predicate the
  // update on DRAFT. A concurrent publish/activate that already moved the exam
  // on makes this a no-op (count 0) instead of re-publishing / emitting a
  // duplicate audit row.
  const { count } = await prisma.exam.updateMany({
    where: { id, status: "DRAFT" },
    data: { status: "PUBLISHED" },
  })
  if (count === 0) {
    return conflict("Nur Entwürfe können veröffentlicht werden")
  }
  const updated = await prisma.exam.findUnique({ where: { id } })

  await createAuditLog({
    action: "EXAM_PUBLISHED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}
