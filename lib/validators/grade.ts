import { z } from "zod"

export const saveGradesSchema = z.object({
  grades: z
    .array(
      z.object({
        questionId: z.string().cuid(),
        points: z.number().min(0),
        feedback: z.string().max(5000).optional(),
      })
    )
    .min(1)
    .max(200),
})

export type SaveGradesInput = z.infer<typeof saveGradesSchema>

const zeroUngradedSchema = z.object({
  action: z.literal("ZERO_UNGRADED"),
  sessionIds: z.array(z.string().cuid()).min(1).max(500),
})

const setPointsSchema = z.object({
  action: z.literal("SET_POINTS"),
  sessionIds: z.array(z.string().cuid()).min(1).max(500),
  questionId: z.string().cuid(),
  points: z.number().min(0),
  feedback: z.string().max(5000).optional(),
})

const markReviewedSchema = z.object({
  action: z.literal("MARK_REVIEWED"),
  sessionIds: z.array(z.string().cuid()).min(1).max(500),
  questionId: z.string().cuid(),
})

export const bulkGradeSchema = z.discriminatedUnion("action", [
  zeroUngradedSchema,
  setPointsSchema,
  markReviewedSchema,
])

export type BulkGradeInput = z.infer<typeof bulkGradeSchema>
