import { z } from "zod"

export const joinExamSchema = z.object({
  accessCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{6}$/, "Zugangscode besteht aus 6 Zeichen"),
})

export const submitSessionSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  // Set by the exam runner when its timer reached 0:00 (see submitKind).
  reason: z.literal("timeout").optional(),
})

export const extendSessionSchema = z.union([
  z.object({ mode: z.literal("NAM") }),
  z.object({ minutes: z.number().int().min(1).max(240) }),
])

export const setBookmarkSchema = z.object({
  questionId: z.string().cuid(),
  bookmarked: z.boolean(),
})

export const extendExamSessionsSchema = z.object({
  minutes: z.number().int().min(1).max(240),
})

export const lockSessionSchema = z.object({
  locked: z.boolean(),
})

export type JoinExamInput = z.infer<typeof joinExamSchema>
export type SubmitSessionInput = z.infer<typeof submitSessionSchema>
export type ExtendSessionInput = z.infer<typeof extendSessionSchema>
export type LockSessionInput = z.infer<typeof lockSessionSchema>
