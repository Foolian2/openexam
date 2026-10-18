import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * All sessions of an exam for the owning teacher. Powers the live monitor
 * (polled) and the grading submissions list.
 */
export async function GET(request: NextRequest, { params }: Params) {
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

  // Only the fields the two callers (live-monitor's table and the
  // dashboard's active-exam-count poll) actually render: no `grades`
  // include. That used to pull every Grade row for every session on every
  // poll (up to student-count × question-count rows) just to reduce them
  // into totals nothing on the client reads.
  const sessions = await prisma.examSession.findMany({
    where: { examId: id },
    select: {
      id: true,
      status: true,
      startedAt: true,
      effectiveEndTime: true,
      timeExtensionMin: true,
      namApplied: true,
      lastSeenAt: true,
      sebIntegrityFlaggedAt: true,
      sebIntegrityReason: true,
      user: { select: { id: true, name: true, email: true } },
      _count: {
        select: {
          answers: true,
          integrityEvents: { where: { kind: { not: "PAGE_FOCUS_LOST" } } },
        },
      },
    },
    orderBy: { startedAt: "asc" },
  })

  const focusLossCounts = await prisma.integrityEvent.groupBy({
    by: ["sessionId"],
    where: { session: { examId: id }, kind: "PAGE_FOCUS_LOST" },
    _count: true,
  })
  const focusLossBySession = new Map(
    focusLossCounts.map((row) => [row.sessionId, row._count])
  )

  return NextResponse.json({
    exam: {
      id: exam.id,
      title: exam.title,
      status: exam.status,
      accessCode: exam.accessCode,
      timeLimitMin: exam.timeLimitMin,
      waitingRoom: exam.waitingRoom,
      questionCount: exam._count.questions,
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      student: s.user,
      status: s.status,
      startedAt: s.startedAt,
      effectiveEndTime: s.effectiveEndTime,
      timeExtensionMin: s.timeExtensionMin,
      namApplied: s.namApplied,
      lastSeenAt: s.lastSeenAt,
      answerCount: s._count.answers,
      integrityEventCount: s._count.integrityEvents,
      focusLossEventCount: focusLossBySession.get(s.id) ?? 0,
      // Same keys the WS snapshot and live delta use, so the monitor renders
      // the flag identically whether it arrived by REST, snapshot, or patch.
      sebIntegrityFlagged: s.sebIntegrityFlaggedAt !== null,
      sebIntegrityReason: s.sebIntegrityReason,
    })),
    serverNow: new Date().toISOString(),
  })
}
