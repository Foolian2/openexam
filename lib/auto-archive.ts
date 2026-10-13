import { ExamStatus } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { createAuditLog } from "@/lib/audit"

export const AUTO_ARCHIVE_AGE_DAYS = 30

export function isEligibleForAutoArchive(
  status: ExamStatus,
  updatedAt: Date,
  now: Date = new Date()
): boolean {
  if (status !== "CLOSED" && status !== "GRADED") return false
  const cutoff = new Date(
    now.getTime() - AUTO_ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000
  )
  return updatedAt.getTime() < cutoff.getTime()
}

export async function sweepAutoArchive(
  userId: string,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - AUTO_ARCHIVE_AGE_DAYS * 24 * 60 * 60 * 1000
  )

  const candidates = await prisma.exam.findMany({
    where: {
      creatorId: userId,
      status: { in: ["CLOSED", "GRADED"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, status: true },
  })
  if (candidates.length === 0) return 0

  const archivedAt = new Date()
  let archivedCount = 0

  // Update and audit-log one exam at a time (rather than batching by status
  // then logging every candidate) so a status change between findMany and
  // the write — e.g. someone reopens the exam concurrently — skips both the
  // update and the audit log for that exam instead of logging a write that
  // never happened.
  for (const exam of candidates) {
    const { count } = await prisma.exam.updateMany({
      where: { id: exam.id, status: exam.status },
      data: {
        status: "ARCHIVED",
        archivedAt,
        statusBeforeArchive: exam.status,
      },
    })
    if (count === 0) continue
    archivedCount++

    await createAuditLog({
      action: "EXAM_ARCHIVED",
      entityType: "Exam",
      entityId: exam.id,
      examId: exam.id,
      userId,
      metadata: { autoArchived: true },
    })
  }

  return archivedCount
}
