import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { conflict, notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (exam.status !== "CLOSED" && exam.status !== "GRADED") {
    return conflict(
      "Nur beendete oder bewertete Prüfungen können archiviert werden"
    )
  }

  const gate = await prisma.exam.updateMany({
    where: { id, status: exam.status },
    data: {
      status: "ARCHIVED",
      archivedAt: new Date(),
      statusBeforeArchive: exam.status,
    },
  })
  if (gate.count === 0) {
    return conflict(
      "Nur beendete oder bewertete Prüfungen können archiviert werden"
    )
  }
  const updated = await prisma.exam.findUniqueOrThrow({ where: { id } })

  await createAuditLog({
    action: "EXAM_ARCHIVED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (exam.status !== "ARCHIVED") {
    return conflict("Nur archivierte Prüfungen können wiederhergestellt werden")
  }

  const gate = await prisma.exam.updateMany({
    where: { id, status: "ARCHIVED" },
    data: {
      status: exam.statusBeforeArchive ?? "GRADED",
      archivedAt: null,
      statusBeforeArchive: null,
    },
  })
  if (gate.count === 0) {
    return conflict("Nur archivierte Prüfungen können wiederhergestellt werden")
  }
  const updated = await prisma.exam.findUniqueOrThrow({ where: { id } })

  await createAuditLog({
    action: "EXAM_UNARCHIVED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam: updated })
}
