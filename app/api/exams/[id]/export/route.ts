import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { csvField as encodeCsvField } from "@/lib/csv"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/** Semicolon-delimited, matching this export's German-Excel oriented rows. */
function csvField(value: string | number | null | undefined): string {
  return encodeCsvField(value, ";")
}

/** CSV export of all submissions with per-question points and totals. */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: { questions: { orderBy: { order: "asc" } } },
  })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }

  await regradeFlaggedSessions({ examId: id })
  const sessions = await prisma.examSession.findMany({
    where: { examId: id },
    include: {
      user: { select: { name: true, email: true } },
      grades: true,
    },
    orderBy: { user: { name: "asc" } },
  })

  const maxTotal = exam.questions.reduce((sum, q) => sum + q.points, 0)
  const header = [
    "Name",
    "E-Mail",
    "Status",
    "Abgegeben am",
    ...exam.questions.map((q, i) => `Frage ${i + 1} (max. ${q.points})`),
    "Total",
    `Maximum (${maxTotal})`,
  ]

  const rows = sessions.map((s) => {
    const gradeByQuestion = new Map(s.grades.map((g) => [g.questionId, g]))
    const perQuestion = exam.questions.map(
      (q) => gradeByQuestion.get(q.id)?.points ?? ""
    )
    const total = s.grades.reduce((sum, g) => sum + g.points, 0)
    return [
      s.user.name,
      s.user.email,
      s.status,
      s.submittedAt?.toISOString() ?? "",
      ...perQuestion,
      total,
      maxTotal,
    ]
  })

  // Semicolon separator + BOM so German-locale Excel opens it correctly.
  const csv =
    "\uFEFF" +
    [header, ...rows].map((row) => row.map(csvField).join(";")).join("\r\n") +
    "\r\n"

  await createAuditLog({
    action: "RESULTS_EXPORTED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    metadata: { sessionCount: sessions.length },
    ipAddress: getClientIp(request) ?? undefined,
  })

  const filename = `openexam-ergebnisse-${exam.id}.csv`
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
