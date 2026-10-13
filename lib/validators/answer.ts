import { z } from "zod"
import { FILE_KEY_RE } from "@/lib/answer-file-key"

// Ids are client-echoed opaque strings; cap sizes so a malicious client
// can't store unbounded payloads through the autosave endpoint.
const idSchema = z.string().max(128)

const mcAnswerSchema = z.object({
  type: z.literal("MULTIPLE_CHOICE"),
  selectedOptionIds: z.array(idSchema).max(200),
})

const freeTextAnswerSchema = z.object({
  type: z.literal("FREE_TEXT"),
  // Rich-text answers carry HTML markup on top of the visible text, so the
  // cap is generous relative to the configurable maxLength (visible chars).
  text: z.string().max(30000),
})

const fillBlankAnswerSchema = z.object({
  type: z.literal("FILL_IN_THE_BLANK"),
  blanks: z
    .array(z.object({ id: idSchema, value: z.string().max(2000) }))
    .max(200),
})

const fileUploadAnswerSchema = z.object({
  type: z.literal("FILE_UPLOAD"),
  // Shape-only gate — it rejects traversal and foreign key shapes, but not
  // another session's key. The route additionally checks ownership with
  // fileKeyBelongsTo, which is the actual authorization boundary.
  fileKey: z.string().max(512).regex(FILE_KEY_RE, "Ungültiger Datei-Schlüssel"),
  fileName: z.string().max(255),
})

const matchingAnswerSchema = z.object({
  type: z.literal("MATCHING"),
  matches: z.array(z.object({ leftId: idSchema, rightId: idSchema })).max(200),
})

const codeAnswerSchema = z.object({
  type: z.literal("CODE"),
  code: z.string().max(50000),
  language: z.string().max(50),
})

const trueFalseAnswerSchema = z.object({
  type: z.literal("TRUE_FALSE"),
  selected: z.boolean(),
})

const shortAnswerAnswerSchema = z.object({
  type: z.literal("SHORT_ANSWER"),
  text: z.string().max(1000),
})

const orderingAnswerSchema = z.object({
  type: z.literal("ORDERING"),
  orderedIds: z.array(idSchema).max(200),
})

export const answerContentSchema = z.discriminatedUnion("type", [
  mcAnswerSchema,
  freeTextAnswerSchema,
  fillBlankAnswerSchema,
  fileUploadAnswerSchema,
  matchingAnswerSchema,
  codeAnswerSchema,
  trueFalseAnswerSchema,
  shortAnswerAnswerSchema,
  orderingAnswerSchema,
])

export const submitAnswerSchema = z.object({
  questionId: z.string().cuid(),
  content: answerContentSchema,
  clientTimestamp: z.number().optional(),
  // See lib/answer-seq.ts. Optional so a client loaded before the field
  // existed keeps saving; the bound matches MaxClientSeq in the Go protocol.
  clientSeq: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
})

export type AnswerContentInput = z.infer<typeof answerContentSchema>
export type SubmitAnswerInput = z.infer<typeof submitAnswerSchema>
