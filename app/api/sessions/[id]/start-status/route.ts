import { NextRequest, NextResponse } from "next/server"
import { requireStudent } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { notFound, rateLimited } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

const LAST_SEEN_EVERY_MS = 30_000

/**
 * What the shared-start waiting room polls: whether the teacher has pressed
 * Start and when the shared clock begins. Metadata only (no questions, no
 * answers), so like GET /api/sessions it carries no SEB guard; the waiting
 * page itself is SEB-checked.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStudent(request, "Nur Schüler haben Sitzungen")
  if (authed instanceof NextResponse) return authed
  const session = authed

  // The room polls every ~2 s; this leaves room for a reload or two.
  const limit = await rateLimit(`start-status:${session.user.id}`, 90, 60)
  if (!limit.allowed) return rateLimited(limit.resetInSeconds)

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      startedAt: true,
      lastSeenAt: true,
      exam: { select: { status: true } },
    },
  })
  if (!examSession || examSession.userId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }

  // Lets the monitor's "Zuletzt aktiv" show who is still in the room. At most
  // one write per student per interval, not one per poll.
  const now = new Date()
  if (
    examSession.status === "WAITING" &&
    (!examSession.lastSeenAt ||
      now.getTime() - examSession.lastSeenAt.getTime() > LAST_SEEN_EVERY_MS)
  ) {
    await prisma.examSession.updateMany({
      where: { id, status: "WAITING" },
      data: { lastSeenAt: now },
    })
  }

  return NextResponse.json({
    status: examSession.status,
    examStatus: examSession.exam.status,
    startedAt: examSession.startedAt,
    serverNow: now.toISOString(),
  })
}
