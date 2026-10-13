import { NextRequest, NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { ExamPrintDocument } from "@/lib/pdf/exam-document"
import {
  buildAnswerSheets,
  buildExamMeta,
  buildExamQuestions,
} from "@/lib/pdf/builders"
import { apiError, notFound } from "@/lib/api-response"

// @react-pdf/renderer needs Node built-ins (Buffer, stream), so the runtime
// is pinned rather than left to inference.
export const runtime = "nodejs"

// renderToBuffer builds the whole document in memory on the request's event
// loop, so one printout stays bounded instead of scaling with the class
// size. Above this, the CSV export is the right tool.
const MAX_PRINT_SESSIONS = 200

type Params = { params: Promise<{ id: string }> }

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

/**
 * Bulk PDF printout for the owning teacher: the exam questions (optionally
 * with a solution key via `?solutions=1`) followed by one answer sheet per
 * submitted student.
 */
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

  const withSolutions = request.nextUrl.searchParams.get("solutions") === "1"

  await regradeFlaggedSessions({ examId: id })

  const sessions = await prisma.examSession.findMany({
    where: { examId: id, status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] } },
    include: {
      user: { select: { name: true, email: true } },
      answers: true,
      grades: true,
    },
    orderBy: { user: { name: "asc" } },
    take: MAX_PRINT_SESSIONS + 1,
  })
  if (sessions.length > MAX_PRINT_SESSIONS) {
    return apiError(
      "PAYLOAD_TOO_LARGE",
      `Zu viele Abgaben für einen Druck (max. ${MAX_PRINT_SESSIONS}). Bitte den CSV-Export verwenden.`,
      413
    )
  }

  const meta = buildExamMeta(exam)
  const pdf = await renderToBuffer(
    <ExamPrintDocument
      exam={meta}
      questions={buildExamQuestions(exam, withSolutions)}
      answerSheets={buildAnswerSheets(exam, sessions)}
      withSolutions={withSolutions}
    />
  )

  await createAuditLog({
    action: "EXAM_PRINTED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    metadata: { sessionCount: sessions.length, withSolutions },
    ipAddress: getClientIp(request) ?? undefined,
  })

  const filename = `openexam-druck-${slugify(exam.title)}.pdf`
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.byteLength),
      "Cache-Control": "no-store",
    },
  })
}
