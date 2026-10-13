import { NextRequest, NextResponse } from "next/server"
import { renderToBuffer } from "@react-pdf/renderer"
import { requireSession } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { regradeFlaggedSessions } from "@/lib/finalize-session"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { StudentResultDocument } from "@/lib/pdf/exam-document"
import { buildStudentPrintData } from "@/lib/pdf/builders"
import { conflict, notFound } from "@/lib/api-response"

// @react-pdf/renderer needs Node built-ins (Buffer, stream), so the runtime
// is pinned rather than left to inference.
export const runtime = "nodejs"

type Params = { params: Promise<{ id: string }> }

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
}

/**
 * Student's own-exam PDF: the exam with their answers filled in and their
 * result. Gated exactly like the results page (`showResults` + graded or
 * archived), so students can only download after grading.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireSession(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  await regradeFlaggedSessions({ id, userId: session.user.id })
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: {
      exam: { include: { questions: { orderBy: { order: "asc" } } } },
      user: { select: { name: true, email: true } },
      answers: true,
      grades: true,
    },
  })
  if (!examSession || examSession.userId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }

  const { exam } = examSession
  const resultsVisible =
    exam.showResults && (exam.status === "GRADED" || exam.status === "ARCHIVED")
  if (!resultsVisible) {
    return conflict("Ergebnisse sind noch nicht verfügbar")
  }

  const data = buildStudentPrintData(examSession)
  const pdf = await renderToBuffer(
    <StudentResultDocument
      exam={data.exam}
      studentName={data.studentName}
      studentEmail={data.studentEmail}
      status={data.status}
      submittedAt={data.submittedAt}
      totalPoints={data.totalPoints}
      maxPoints={data.maxPoints}
      questions={data.questions}
    />
  )

  await createAuditLog({
    action: "RESULT_PDF_DOWNLOADED",
    entityType: "ExamSession",
    entityId: id,
    examId: exam.id,
    userId: session.user.id,
    metadata: { examId: exam.id },
    ipAddress: getClientIp(request) ?? undefined,
  })

  const filename = `openexam-ergebnis-${slugify(exam.title)}.pdf`
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.byteLength),
      "Cache-Control": "no-store",
    },
  })
}
