import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Full integrity-event log for one session, for the teacher's live-monitor
 * detail view. These are best-effort client-reported behavioral signals
 * (tab switch, window blur, clipboard/devtools attempt) — not proof of
 * cheating on their own.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const examSession = await prisma.examSession.findUnique({
    where: { id },
    include: { exam: { select: { creatorId: true } } },
  })
  if (!examSession || examSession.exam.creatorId !== session.user.id) {
    return notFound("Sitzung nicht gefunden")
  }

  // Ordered by and displayed as the server-side receive time: clientTime is
  // whatever the student's browser claims, so a skewed clock (or a hostile
  // client) would otherwise scramble the timeline the teacher is shown.
  const events = await prisma.integrityEvent.findMany({
    where: { sessionId: id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      kind: true,
      detail: true,
      createdAt: true,
      clientTime: true,
    },
  })

  return NextResponse.json({ events })
}
