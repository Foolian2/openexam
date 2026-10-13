export interface GradingProgress {
  graded: number
  total: number
  open: number
  firstOpenId: string | null
}

export interface GradingProgressQuestion {
  id: string
  points: number
}

/** A draft only counts as graded when its value is a number within the
 * question's allowed [0, points] range — matching the bounds handleSave
 * enforces, so progress can't report "complete" for a score save would
 * reject. */
function isValidScore(raw: string, maxPoints: number): boolean {
  if (!raw.trim()) return false
  const points = Number(raw)
  return !Number.isNaN(points) && points >= 0 && points <= maxPoints
}

export function getGradingProgress(
  questions: GradingProgressQuestion[],
  drafts: Record<string, { points: string } | undefined>
): GradingProgress {
  let graded = 0
  let firstOpenId: string | null = null

  for (const question of questions) {
    const draft = drafts[question.id]
    if (draft && isValidScore(draft.points, question.points)) {
      graded += 1
    } else if (firstOpenId === null) {
      firstOpenId = question.id
    }
  }

  return {
    graded,
    total: questions.length,
    open: questions.length - graded,
    firstOpenId,
  }
}
