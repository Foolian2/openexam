export interface MCConfig {
  multiSelect: boolean
  options: {
    id: string
    text: string
    isCorrect: boolean
  }[]
}

/** A single grading criterion with its point value, authored by the
 * teacher and shown as a checklist while grading. Never sent to students. */
export interface RubricItem {
  id: string
  criterion: string
  points: number
}

export interface FreeTextConfig {
  maxLength: number
  expectedKeywords?: string[]
  richText: boolean
  rubric?: RubricItem[]
}

export interface FillBlankConfig {
  template: string
  blanks: {
    id: string
    acceptedAnswers: string[]
    caseSensitive: boolean
  }[]
}

export interface FileUploadConfig {
  allowedExtensions: string[]
  maxFileSizeMB: number
  instructions: string
}

export interface MatchingConfig {
  pairs: {
    id: string
    left: string
    right: string
  }[]
  shuffleSides: boolean
}

/**
 * Student-facing shape of a MATCHING config: left/right sides are decoupled
 * and right-side ids are opaque per-session values, so the pairing (the
 * solution) never reaches the client.
 */
export interface SanitizedMatchingConfig {
  left: { id: string; text: string }[]
  right: { id: string; text: string }[]
  shuffleSides: boolean
}

export interface CodeConfig {
  language: string
  starterCode: string
  testCases: {
    input: string
    expectedOutput: string
    hidden: boolean
    points: number
  }[]
}

/**
 * TRUE_FALSE: a single statement the student marks as true ("Wahr") or
 * false ("Falsch"). `isCorrect` is the boolean the student must select to
 * be awarded points. There are no per-question labels — the viewer always
 * renders the fixed German strings "Wahr" / "Falsch".
 */
export interface TrueFalseConfig {
  isCorrect: boolean
}

/**
 * SHORT_ANSWER: a single short text answer that is auto-graded by exact
 * (trimmed, optionally case-insensitive) string match against any of the
 * `acceptedAnswers` variants. Distinct from FREE_TEXT (which is manual)
 * and FILL_IN_THE_BLANK (which has multiple blanks in a template).
 */
export interface ShortAnswerConfig {
  acceptedAnswers: string[]
  caseSensitive: boolean
  maxLength: number
  rubric?: RubricItem[]
}

/**
 * ORDERING: a list of items that the student must arrange into the correct
 * order. The items array is stored in the CORRECT order (that is the
 * solution). Before reaching the client, `sanitizeQuestionConfig`
 * shuffles the items server-side (deterministically per session seed) so
 * the source order never leaks. The student returns `{ orderedIds }` —
 * the item ids in the order they arranged. Grading compares positions
 * against the original `config.items` order.
 *
 * When `shuffle` is false, the server still reverses the items before
 * sending them (so a teacher who types them in correct order doesn't
 * accidentally hand the solution to the student); `shuffle` only controls
 * whether the shuffle is randomized per-session or fixed (reversed).
 */
export interface OrderingConfig {
  items: {
    id: string
    text: string
  }[]
  shuffle: boolean
}

/**
 * Student-facing shape of an ORDERING config: items are presented in a
 * server-shuffled order with their original ids retained, so the student's
 * answer (`{ orderedIds }`) can be graded position-by-position against
 * the canonical order stored in the (unsanitized) config.
 */
export interface SanitizedOrderingConfig {
  items: { id: string; text: string }[]
  shuffle: boolean
}

/** The stored (teacher-side) config of each question type, incl. solutions. */
export interface ConfigByType {
  MULTIPLE_CHOICE: MCConfig
  FREE_TEXT: FreeTextConfig
  FILL_IN_THE_BLANK: FillBlankConfig
  FILE_UPLOAD: FileUploadConfig
  MATCHING: MatchingConfig
  CODE: CodeConfig
  TRUE_FALSE: TrueFalseConfig
  SHORT_ANSWER: ShortAnswerConfig
  ORDERING: OrderingConfig
}

/**
 * Mirrors the Prisma `QuestionType` enum; lib/validators/question.ts fails
 * to compile if the two ever disagree.
 */
export type QuestionType = keyof ConfigByType

/**
 * What `sanitizeQuestionConfig` (lib/exam-session.ts) hands a student for
 * each type, i.e. with every solution field stripped or blanked.
 */
export interface StudentConfigByType {
  /** `isCorrect` is forced to false on every option. */
  MULTIPLE_CHOICE: MCConfig
  FREE_TEXT: Pick<FreeTextConfig, "maxLength" | "richText">
  /** `acceptedAnswers` is emptied on every blank. */
  FILL_IN_THE_BLANK: FillBlankConfig
  FILE_UPLOAD: FileUploadConfig
  MATCHING: SanitizedMatchingConfig
  /** Hidden test cases are dropped and expected outputs blanked. */
  CODE: CodeConfig
  /** The boolean to select is the solution, so nothing is left. */
  TRUE_FALSE: Record<string, never>
  SHORT_ANSWER: Pick<ShortAnswerConfig, "maxLength" | "caseSensitive">
  ORDERING: SanitizedOrderingConfig
}

/** Viewers render both sides: a student's sanitized config and a teacher's full one. */
export type ViewerConfigByType = {
  [T in QuestionType]: ConfigByType[T] | StudentConfigByType[T]
}

type QuestionOf<M> = { [T in keyof M]: { type: T; config: M[T] } }[keyof M]

/** A question's `type` and `config`, correlated so `switch (q.type)` narrows `q.config`. */
export type QuestionConfig = QuestionOf<ConfigByType>
export type StudentQuestionConfig = QuestionOf<StudentConfigByType>
export type ViewerQuestionConfig = QuestionOf<ViewerConfigByType>

/**
 * Narrows a question row (Prisma's `type` enum + JSON `config`) to the
 * correlated union.
 *
 * This is the single place that *trusts* the stored config instead of
 * re-validating it: every write goes through `configSchemaByType`
 * (lib/validators/question.ts), and a read-side parse would turn a config
 * written before some schema tightening into a hard failure mid-exam.
 */
export function asTypedQuestion<Q extends { type: string; config: unknown }>(
  question: Q
): Omit<Q, "type" | "config"> & QuestionConfig {
  return question as unknown as Omit<Q, "type" | "config"> & QuestionConfig
}

/** The grading rubric, for the question types that have one. */
export function rubricOf(question: QuestionConfig): RubricItem[] | undefined {
  return question.type === "FREE_TEXT" || question.type === "SHORT_ANSWER"
    ? question.config.rubric
    : undefined
}
