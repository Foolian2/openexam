import { z } from "zod"
import type { QuestionType as PrismaQuestionType } from "@/generated/prisma/enums"
import type { QuestionType } from "@/lib/types/questions"
import { MAX_UPLOAD_MB } from "@/lib/upload-budget"
import { placeholderIds } from "@/lib/fill-blank-template"

/** Upper bound for a question's points (any decimal below it is fine). */
export const MAX_QUESTION_POINTS = 1000

/**
 * Rejects repeated ids in a config array. Students' answers reference these
 * ids, so two options/items/pairs/blanks sharing one cannot be told apart:
 * clicking one option selected both, and an ordering item lost its text.
 * The editor generates unique ids; this guards the API and imported files.
 */
function uniqueIds<T extends { id: string }>(
  items: T[],
  ctx: z.RefinementCtx,
  label: string
) {
  const seen = new Set<string>()
  items.forEach((item, i) => {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: "custom",
        path: [i, "id"],
        message: `${label}: ID «${item.id}» kommt mehrfach vor`,
      })
    }
    seen.add(item.id)
  })
}

const mcConfigSchema = z
  .object({
    multiSelect: z.boolean(),
    options: z
      .array(
        z.object({
          id: z.string(),
          text: z.string().min(1, "Optionstext darf nicht leer sein"),
          isCorrect: z.boolean(),
        })
      )
      .min(2, "Mindestens 2 Optionen erforderlich")
      .max(10, "Maximal 10 Optionen erlaubt")
      .refine((opts) => opts.some((o) => o.isCorrect), {
        message: "Mindestens eine Option muss korrekt sein",
      })
      .superRefine((opts, ctx) => uniqueIds(opts, ctx, "Option")),
  })
  .superRefine((c, ctx) => {
    // Grading needs the exact set of correct options, and a single-select
    // question lets the student pick only one: with two marked correct, full
    // points were unreachable.
    if (!c.multiSelect && c.options.filter((o) => o.isCorrect).length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message:
          "Bei Einfachauswahl darf nur eine Option korrekt sein (sonst Mehrfachauswahl aktivieren)",
      })
    }
  })

const rubricItemSchema = z.object({
  id: z.string(),
  criterion: z.string().min(1, "Kriterium darf nicht leer sein"),
  points: z.number().min(0, "Punkte dürfen nicht negativ sein"),
})

const freeTextConfigSchema = z.object({
  maxLength: z.number().int().min(1).max(10000),
  expectedKeywords: z.array(z.string()).optional(),
  richText: z.boolean(),
  rubric: z
    .array(rubricItemSchema)
    .max(20, "Maximal 20 Kriterien erlaubt")
    .optional(),
})

const fillBlankConfigSchema = z
  .object({
    template: z.string().min(1, "Vorlage darf nicht leer sein"),
    blanks: z
      .array(
        z.object({
          id: z.string(),
          acceptedAnswers: z
            .array(z.string().min(1, "Antwort darf nicht leer sein"))
            .min(1, "Mindestens eine akzeptierte Antwort erforderlich"),
          caseSensitive: z.boolean(),
        })
      )
      .min(1, "Mindestens eine Lücke erforderlich")
      .superRefine((blanks, ctx) => uniqueIds(blanks, ctx, "Lücke")),
  })
  .superRefine((c, ctx) => {
    // The student sees one input per {n} in the template, bound to blank n.
    // A blank missing from the template can never be answered, a placeholder
    // without a blank has no accepted answers, and a repeated placeholder
    // renders two inputs sharing one answer.
    const placeholders = placeholderIds(c.template)
    const seen = new Set<string>()
    for (const id of placeholders) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["template"],
          message: `Platzhalter {${id}} kommt mehrfach vor`,
        })
      }
      seen.add(id)
    }
    const blankIds = new Set(c.blanks.map((b) => b.id))
    for (const id of seen) {
      if (!blankIds.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["template"],
          message: `Zu Platzhalter {${id}} gibt es keine Lücke`,
        })
      }
    }
    c.blanks.forEach((b, i) => {
      if (!seen.has(b.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["blanks", i],
          message: `Lücke ${b.id} kommt in der Vorlage nicht vor (Platzhalter {${b.id}} fehlt)`,
        })
      }
    })
  })

const fileUploadConfigSchema = z.object({
  allowedExtensions: z
    .array(z.string())
    .min(1, "Mindestens eine Dateierweiterung erforderlich"),
  // Clamped, not rejected: question-bank exports and older imports may still
  // carry the pre-Postgres 100 MB limit.
  maxFileSizeMB: z
    .number()
    .min(1)
    .transform((v) => Math.min(v, MAX_UPLOAD_MB)),
  instructions: z.string(),
})

const matchingConfigSchema = z.object({
  pairs: z
    .array(
      z.object({
        id: z.string(),
        left: z.string().min(1, "Begriff darf nicht leer sein"),
        right: z.string().min(1, "Definition darf nicht leer sein"),
      })
    )
    .min(3, "Mindestens 3 Paare erforderlich")
    .max(10, "Maximal 10 Paare erlaubt")
    .superRefine((pairs, ctx) => {
      uniqueIds(pairs, ctx, "Paar")
      // Two identical definitions can't be told apart by the student, but
      // only one of them is graded as correct for each term.
      const seen = new Set<string>()
      pairs.forEach((p, i) => {
        const key = p.right.trim().toLowerCase()
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [i, "right"],
            message: `Definition «${p.right.trim()}» kommt mehrfach vor`,
          })
        }
        seen.add(key)
      })
    }),
  shuffleSides: z.boolean(),
})

const codeConfigSchema = z.object({
  language: z.enum(["python", "javascript"]),
  starterCode: z.string(),
  testCases: z.array(
    z.object({
      input: z.string(),
      expectedOutput: z.string(),
      hidden: z.boolean(),
      points: z.number().min(0),
    })
  ),
})

const trueFalseConfigSchema = z.object({
  isCorrect: z.boolean(),
})

const shortAnswerConfigSchema = z.object({
  acceptedAnswers: z
    .array(z.string().min(1, "Antwort darf nicht leer sein"))
    .min(1, "Mindestens eine akzeptierte Antwort erforderlich"),
  caseSensitive: z.boolean(),
  maxLength: z.number().int().min(1).max(1000),
  rubric: z
    .array(rubricItemSchema)
    .max(20, "Maximal 20 Kriterien erlaubt")
    .optional(),
})

const orderingConfigSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().min(1, "Elementtext darf nicht leer sein"),
      })
    )
    .min(2, "Mindestens 2 Elemente erforderlich")
    .max(20, "Maximal 20 Elemente erlaubt")
    .superRefine((items, ctx) => uniqueIds(items, ctx, "Element")),
  shuffle: z.boolean(),
})

/** Per-type config schema lookup, reused for both create and partial update. */
export const configSchemaByType = {
  MULTIPLE_CHOICE: mcConfigSchema,
  FREE_TEXT: freeTextConfigSchema,
  FILL_IN_THE_BLANK: fillBlankConfigSchema,
  FILE_UPLOAD: fileUploadConfigSchema,
  MATCHING: matchingConfigSchema,
  CODE: codeConfigSchema,
  TRUE_FALSE: trueFalseConfigSchema,
  SHORT_ANSWER: shortAnswerConfigSchema,
  ORDERING: orderingConfigSchema,
} as const

export type { QuestionType }

// Compile-time drift guards: the schema map, the TS config map and the
// Prisma enum must all name exactly the same question types.
type AssertEqual<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never
const _schemaKeysMatch: AssertEqual<
  keyof typeof configSchemaByType,
  QuestionType
> = true
const _prismaEnumMatches: AssertEqual<PrismaQuestionType, QuestionType> = true
void _schemaKeysMatch
void _prismaEnumMatches

const questionConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("MULTIPLE_CHOICE"), config: mcConfigSchema }),
  z.object({ type: z.literal("FREE_TEXT"), config: freeTextConfigSchema }),
  z.object({
    type: z.literal("FILL_IN_THE_BLANK"),
    config: fillBlankConfigSchema,
  }),
  z.object({ type: z.literal("FILE_UPLOAD"), config: fileUploadConfigSchema }),
  z.object({ type: z.literal("MATCHING"), config: matchingConfigSchema }),
  z.object({ type: z.literal("CODE"), config: codeConfigSchema }),
  z.object({ type: z.literal("TRUE_FALSE"), config: trueFalseConfigSchema }),
  z.object({
    type: z.literal("SHORT_ANSWER"),
    config: shortAnswerConfigSchema,
  }),
  z.object({ type: z.literal("ORDERING"), config: orderingConfigSchema }),
])

export const createQuestionSchema = z
  .object({
    title: z.string().min(1, "Titel ist erforderlich").max(500),
    points: z
      .number()
      .positive("Punkte müssen grösser als 0 sein")
      .max(MAX_QUESTION_POINTS, `Maximal ${MAX_QUESTION_POINTS} Punkte`),
    required: z.boolean().default(true),
  })
  .and(questionConfigSchema)

export const updateQuestionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  points: z
    .number()
    .positive("Punkte müssen grösser als 0 sein")
    .max(MAX_QUESTION_POINTS, `Maximal ${MAX_QUESTION_POINTS} Punkte`)
    .optional(),
  required: z.boolean().optional(),
  config: z.unknown().optional(),
})

/**
 * Question-bank variant of the partial update: same fields plus the
 * optional folder assignment (exam questions have no folders, so the
 * folderId lives here rather than in the shared schema).
 */
export const questionBankUpdateSchema = updateQuestionSchema.extend({
  folderId: z.string().cuid().nullable().optional(),
})

/**
 * Validates the partial update payload, including the `config` blob against the
 * schema for the question's actual stored type so arbitrary JSON can't be
 * persisted (and later rendered) via PATCH.
 */
export function validateQuestionUpdate(type: QuestionType, body: unknown) {
  const base = updateQuestionSchema.safeParse(body)
  if (!base.success) return base

  if (base.data.config !== undefined) {
    const configResult = configSchemaByType[type].safeParse(base.data.config)
    if (!configResult.success) return configResult
    return {
      success: true as const,
      data: { ...base.data, config: configResult.data },
    }
  }

  return { success: true as const, data: base.data }
}

/** Same validation as `validateQuestionUpdate`, plus the folderId field. */
export function validateQuestionBankUpdate(type: QuestionType, body: unknown) {
  const base = questionBankUpdateSchema.safeParse(body)
  if (!base.success) return base

  if (base.data.config !== undefined) {
    const configResult = configSchemaByType[type].safeParse(base.data.config)
    if (!configResult.success) return configResult
    return {
      success: true as const,
      data: { ...base.data, config: configResult.data },
    }
  }

  return { success: true as const, data: base.data }
}

export const reorderQuestionsSchema = z.object({
  questionIds: z.array(z.string()).min(1),
})

export type CreateQuestionInput = z.infer<typeof createQuestionSchema>
export type UpdateQuestionInput = z.infer<typeof updateQuestionSchema>
