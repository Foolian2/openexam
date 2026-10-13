import { createHmac } from "node:crypto"
import type {
  QuestionType,
  QuestionConfig,
  StudentConfigByType,
  StudentQuestionConfig,
  MatchingConfig,
  OrderingConfig,
} from "@/lib/types/questions"

/**
 * Server-only: keyed with MATCHING_ID_SECRET and node:crypto. Never import
 * from a client component — the guard below fails module evaluation in the
 * browser rather than silently deriving answer-hiding values client-side.
 */
if (typeof window !== "undefined") {
  throw new Error("lib/exam-session is server-only")
}

// Keys both the MATCHING right-side ids and the ORDERING display permutation.
// (Env name kept for deployment compatibility.)
const questionSecret = process.env.MATCHING_ID_SECRET

// Fail loudly on misconfiguration rather than silently deriving answer-hiding
// values from a plain hash of publicly-known inputs (seed, pairId, and the
// item ids are all visible to the client), which would let a student
// recompute the answer key.
if (process.env.NODE_ENV === "production" && !questionSecret) {
  throw new Error("MATCHING_ID_SECRET must be set")
}

function secret(): string {
  return questionSecret ?? "dev-only-insecure-matching-secret"
}

export function computeEffectiveEndTime(
  startedAt: Date,
  timeLimitMin: number,
  timeExtensionMin: number
): Date {
  return new Date(
    startedAt.getTime() + (timeLimitMin + timeExtensionMin) * 60_000
  )
}

/**
 * Pushes an existing deadline out by `extraMinutes`. Used by the teacher's
 * extend endpoint: adding to the current deadline (rather than recomputing
 * from startedAt + the exam's timeLimitMin) keeps the grant independent of
 * mid-exam edits to the exam's time limit.
 */
export function extendEffectiveEndTime(end: Date, extraMinutes: number): Date {
  return new Date(end.getTime() + extraMinutes * 60_000)
}

/**
 * Opaque per-session id for the right-hand side of a matching pair. The raw
 * pair id links left and right sides (the id-coupling IS the solution), so the
 * client must only ever see this derived id for right-side items. Grading
 * recomputes it from the same seed to check submitted matches.
 *
 * This is an HMAC keyed with a server-only secret, not a plain hash: `seed`
 * (sessionId:questionId) and `pairId` (the left-side id) are both sent to the
 * client, so a plain hash of them would be recomputable client-side and
 * would leak the pairing it's meant to hide.
 */
export function matchingRightId(seed: string, pairId: string): string {
  return createHmac("sha256", secret())
    .update(`${seed}:${pairId}`)
    .digest("hex")
    .slice(0, 16)
}

/**
 * {@link sanitizeQuestionConfig} for a whole question row: returns the row
 * with `config` replaced by the student-facing one and `type`/`config`
 * correlated, so callers can `switch (q.type)` and get a typed config.
 */
export function sanitizeQuestion<
  Q extends { type: QuestionType; config: unknown },
>(
  question: Q,
  matchingSeed?: string
): Omit<Q, "type" | "config"> & StudentQuestionConfig {
  return {
    ...question,
    config: sanitizeQuestionConfig(
      question.type,
      question.config,
      matchingSeed
    ),
  } as Omit<Q, "type" | "config"> & StudentQuestionConfig
}

/**
 * Strips grading information from a question config before it is sent to a
 * student. Never send the raw `config` column to a student client — it
 * contains the solutions.
 *
 * `matchingSeed` must be provided for MATCHING questions (use
 * `${sessionId}:${questionId}`) so right-side items get opaque per-session ids
 * that don't reveal the pairing.
 */
export function sanitizeQuestionConfig<T extends QuestionType>(
  type: T,
  config: unknown,
  matchingSeed?: string
): StudentConfigByType[T]
export function sanitizeQuestionConfig(
  type: QuestionType,
  config: unknown,
  matchingSeed?: string
): StudentConfigByType[QuestionType] {
  // The config column is validated on write, so it is trusted here; this
  // pairs it with its type so each case below gets the right config shape.
  const q = { type, config } as QuestionConfig
  switch (q.type) {
    case "MULTIPLE_CHOICE": {
      const c = q.config
      return {
        multiSelect: c.multiSelect,
        options: c.options.map(({ id, text }) => ({
          id,
          text,
          isCorrect: false,
        })),
      }
    }
    case "FREE_TEXT": {
      const c = q.config
      return { maxLength: c.maxLength, richText: c.richText }
    }
    case "FILL_IN_THE_BLANK": {
      const c = q.config
      return {
        template: c.template,
        blanks: c.blanks.map(({ id, caseSensitive }) => ({
          id,
          caseSensitive,
          acceptedAnswers: [],
        })),
      }
    }
    case "FILE_UPLOAD":
      // Contains no solution data.
      return q.config
    case "MATCHING": {
      if (!matchingSeed) {
        throw new Error(
          "matchingSeed is required to sanitize a MATCHING config"
        )
      }
      const c: MatchingConfig | null = q.config
      if (!c || !Array.isArray(c.pairs)) {
        return { left: [], right: [], shuffleSides: false }
      }
      const seed = matchingSeed
      const right = c.pairs.map((p) => ({
        id: matchingRightId(seed, p.id),
        text: p.right,
      }))
      // The right array is built in pair order, so right[i] is the answer to
      // left[i]. It must ALWAYS be permuted with a permutation the client
      // cannot reproduce — exactly like ORDERING. seededShuffle (keyed only by
      // the client-known sessionId:questionId) let a student replay the
      // shuffle and invert it to recover every pairing, even with
      // shuffleSides=true; shuffleSides=false handed over a position-aligned
      // answer key outright. keyedShuffle is keyed with the server secret, and
      // grading recomputes matchingRightId(seed, leftId) so the right-side
      // order never affects correctness. shuffleSides stays in the payload for
      // the client type but can no longer disable the permutation.
      return {
        left: c.pairs.map((p) => ({ id: p.id, text: p.left })),
        right: keyedShuffle(right, seed),
        shuffleSides: c.shuffleSides,
      }
    }
    case "CODE": {
      const c = q.config
      return {
        language: c.language,
        starterCode: c.starterCode,
        testCases: c.testCases
          .filter((tc) => !tc.hidden)
          .map((tc) => ({
            input: tc.input,
            expectedOutput: "",
            hidden: false,
            points: tc.points,
          })),
      }
    }
    case "TRUE_FALSE":
      // The boolean the student must select IS the solution, so strip it.
      return {}
    case "SHORT_ANSWER": {
      const c = q.config
      // Drop acceptedAnswers (the key); keep maxLength and caseSensitive so
      // the client can mirror the grading rules in its UI (e.g. enforce
      // maxLength on the input).
      return { maxLength: c.maxLength, caseSensitive: c.caseSensitive }
    }
    case "ORDERING": {
      if (!matchingSeed) {
        throw new Error(
          "matchingSeed is required to sanitize an ORDERING config"
        )
      }
      const c: OrderingConfig | null = q.config
      if (!c || !Array.isArray(c.items) || c.items.length === 0) {
        return { items: [], shuffle: false }
      }
      // The items array is stored in the CORRECT order (the order IS the
      // solution), so it must always be permuted before it reaches the client
      // — and with a permutation the client cannot reproduce. See keyedShuffle.
      // The teacher's `shuffle` flag is passed through for the UI but cannot
      // switch the permutation off: "display the items in their stored order"
      // means "hand the student the answer key".
      const displayed = keyedShuffle(c.items, matchingSeed)
      return {
        items: displayed.map((i) => ({ id: i.id, text: i.text })),
        shuffle: c.shuffle,
      }
    }
    default: {
      // Exhaustiveness guard. Without it, adding a QuestionType and
      // forgetting a case here falls out of the switch as `undefined` — the
      // student's client would render an unanswerable question instead of
      // the server failing loudly, and a config-shaped hole like that is
      // exactly where an unsanitized solution would slip through later.
      const unhandled: never = q
      throw new Error(
        `sanitizeQuestionConfig: unhandled question type ${String(
          (unhandled as { type: unknown }).type
        )}`
      )
    }
  }
}

/**
 * Deterministic-per-session shuffle, keyed with the server-only secret.
 *
 * Use this — never `seededShuffle` — wherever the *source order* is itself the
 * solution (ORDERING). `seed` is `${sessionId}:${questionId}` and the student
 * knows both halves, so an unkeyed PRNG lets them replay the exact shuffle and
 * invert it back to the stored (correct) order. Keying the stream makes the
 * permutation unpredictable while keeping it stable across reloads.
 *
 * No attempt is made to force a non-identity permutation: the shuffle lands on
 * the correct order 1/n! of the time, and "guaranteed to differ from correct"
 * is itself exploitable — for n = 2 it would mean always displaying the
 * reverse, which the student simply flips back.
 */
export function keyedShuffle<T>(items: T[], seed: string): T[] {
  const rand = keyedRandom(seed)
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/** Stream of uniform floats in [0, 1), expanded from an HMAC keyed with the secret. */
function keyedRandom(seed: string): () => number {
  let block = Buffer.alloc(0)
  let offset = 0
  let counter = 0
  return () => {
    if (offset + 4 > block.length) {
      block = createHmac("sha256", secret())
        .update(`${seed}:${counter++}`)
        .digest()
      offset = 0
    }
    const value = block.readUInt32BE(offset)
    offset += 4
    return value / 4294967296
  }
}

/**
 * Deterministic-per-session shuffle so reloads keep the same question order.
 *
 * Unkeyed: the permutation is recomputable by anyone who knows the seed. Only
 * safe where the pre-shuffle order carries no solution (question order, MC
 * options). NOT safe for the MATCHING right-hand side: its ids are opaque, but
 * the pre-shuffle order is pair-aligned with the left side, so a replayable
 * permutation leaks the pairing — that side uses keyedShuffle instead.
 */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const rand = () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return (h >>> 0) / 4294967296
  }
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}
