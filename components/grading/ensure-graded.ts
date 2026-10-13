import { toast } from "sonner"

/**
 * Backfills auto-grades for submitted sessions that a crash left without
 * any (POST /api/exams/[id]/ensure-graded). Run once before a grading view
 * loads. Never throws: on failure the teacher is told and the view still
 * loads whatever grades exist.
 */
export async function ensureGraded(
  examId: string,
  sessionId?: string
): Promise<void> {
  try {
    const res = await fetch(`/api/exams/${examId}/ensure-graded`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
    if (res.ok) return
  } catch {
    // Reported below, same as a non-2xx reply.
  }
  toast.error(
    "Fehlende automatische Bewertungen konnten nicht nachgeholt werden."
  )
}
