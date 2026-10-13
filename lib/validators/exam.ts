import { z } from "zod"

export const examStatusSchema = z.enum([
  "DRAFT",
  "PUBLISHED",
  "ACTIVE",
  "CLOSED",
  "GRADED",
  "ARCHIVED",
])

export type ExamStatus = z.infer<typeof examStatusSchema>

const scheduleIsOrdered = (data: {
  scheduledStart?: string | null
  scheduledEnd?: string | null
}) =>
  !data.scheduledStart ||
  !data.scheduledEnd ||
  new Date(data.scheduledEnd) > new Date(data.scheduledStart)

const scheduleError = {
  message: "Geplantes Ende muss nach dem geplanten Start liegen",
  path: ["scheduledEnd"],
}

// A shared-start exam has no scheduled end (lib/exam-schedule.ts
// scheduledEndCap): everyone gets the full time from the teacher's Start.
const noEndWithWaitingRoom = (data: {
  waitingRoom?: boolean
  scheduledEnd?: string | null
}) => !data.waitingRoom || !data.scheduledEnd

const waitingRoomEndError = {
  message:
    "Mit gemeinsamem Start gibt es kein geplantes Ende: Alle erhalten die volle Dauer ab dem Start.",
  path: ["scheduledEnd"],
}

// Boolean flags default to false ONLY on create. The update schema must not
// carry these defaults: `.partial()` keeps a `.default(false)` field, so a
// partial PATCH that omits (say) sebRequired would otherwise materialize it as
// `false` and silently turn SEB off — and make the SEB "locked field present"
// check fire on a field the client never sent. The update shape leaves omitted
// flags `undefined` so the route writes only what was actually provided.
const examFlagFields = {
  shuffleQuestions: z.boolean(),
  shuffleOptions: z.boolean(),
  showResults: z.boolean(),
  sebRequired: z.boolean(),
  waitingRoom: z.boolean(),
}

const examCoreSchema = z.object({
  title: z.string().min(1, "Titel ist erforderlich").max(200),
  description: z.string().max(2000).optional(),
  timeLimitMin: z
    .number()
    .int()
    .min(1, "Mindestdauer ist 1 Minute")
    .max(600, "Maximaldauer ist 600 Minuten"),
  // null removes a schedule bound that was set before.
  scheduledStart: z.string().datetime().nullable().optional(),
  scheduledEnd: z.string().datetime().nullable().optional(),
})

export const createExamSchema = examCoreSchema
  .extend({
    shuffleQuestions: examFlagFields.shuffleQuestions.default(false),
    shuffleOptions: examFlagFields.shuffleOptions.default(false),
    showResults: examFlagFields.showResults.default(false),
    sebRequired: examFlagFields.sebRequired.default(false),
    waitingRoom: examFlagFields.waitingRoom.default(false),
  })
  .refine(scheduleIsOrdered, scheduleError)
  .refine(noEndWithWaitingRoom, waitingRoomEndError)

// Note: only guards orderings when both fields are present in the payload —
// a partial update changing one bound is validated against the other in the route.
export const updateExamSchema = examCoreSchema
  .extend(examFlagFields)
  .partial()
  .refine(scheduleIsOrdered, scheduleError)
  .refine(noEndWithWaitingRoom, waitingRoomEndError)

export type CreateExamInput = z.infer<typeof createExamSchema>
export type UpdateExamInput = z.infer<typeof updateExamSchema>
