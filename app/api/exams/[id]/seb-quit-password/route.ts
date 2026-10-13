import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { rateLimit } from "@/lib/rate-limit"
import { decryptSecret } from "@/lib/at-rest-encryption"
import { notFound, rateLimited } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Reveals the exam's plaintext SEB quit password on demand. The monitor page
 * itself never selects sebQuitPassword into its server-rendered payload — the
 * plaintext must not sit in page props or view-source for something a
 * projector routinely displays; see components/monitor/seb-quit-password.tsx.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  // Tight budget: this is a sensitive reveal endpoint, not a routine poll.
  const limit = await rateLimit(
    `seb-quit-password:${session.user.id}`,
    10,
    60,
    "closed"
  )
  if (!limit.allowed) {
    return rateLimited(limit.resetInSeconds)
  }

  const { id } = await params
  const exam = await prisma.exam.findUnique({
    where: { id },
    select: { creatorId: true, sebQuitPassword: true },
  })
  if (!exam || exam.creatorId !== session.user.id) {
    return notFound("Prüfung nicht gefunden")
  }
  if (!exam.sebQuitPassword) {
    return notFound("Kein Notfall-Passwort gesetzt")
  }

  await createAuditLog({
    action: "SEB_QUIT_PASSWORD_REVEALED",
    entityType: "Exam",
    entityId: id,
    examId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ password: decryptSecret(exam.sebQuitPassword) })
}
