import { timingSafeEqual } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { configKeyTokenForUrl } from "@/lib/seb-key"
import { takeUrl } from "@/lib/seb-urls"
import { redis } from "@/lib/redis"
import { createAuditLog } from "@/lib/audit"

export interface SebGuardExam {
  id: string
  sebRequired: boolean
  sebConfigKey: string | null
}

export interface SebGuardSession {
  id: string
  /**
   * Config Key of the personalized config issued to this student, if any. Null
   * means this session only ever used the anonymous config and validates
   * against exam.sebConfigKey alone — the pre-auto-login behaviour.
   */
  sebConfigKey: string | null
  sebKeyHash: string | null
  sebUserAgent: string | null
  sebBrowserExamKey: string | null
  sebIntegrityFlaggedAt: Date | null
}

export type SebGuardResult = { ok: true } | { ok: false; reason: string }

export type SebIntegrityReason = "bek_changed" | "bek_disappeared"

/** Constant-time string comparison; unequal lengths short-circuit to false. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Re-exported for existing importers.
export { isSEBUserAgent } from "@/lib/seb-user-agent"

export type BekDecision = "noop" | "bind" | "flag"

export interface BekDecisionInput {
  /** Bound BEK from the session; null or an empty string counts as nothing bound. */
  bound: string | null
  /** The presented BEK; "" for absent. */
  presented: string
  /** Constant-time comparison of `presented` against `bound`, computed by the caller. */
  presentedMatches: boolean
  /** Whether the session is already integrity-flagged (sebIntegrityFlaggedAt set). */
  alreadyFlagged: boolean
}

/**
 * The pure BEK decision rule, shared with ws-backend/main.go's
 * sebIntegrityDecision via testdata/seb-token-vectors.json.
 *
 * Never rejects: locking out a student mid-exam is worse than a missed
 * detection. An empty bound value counts as unbound, as in the Go store.
 */
export function decideBekAction(input: BekDecisionInput): {
  action: BekDecision
  reason?: "bek_changed" | "bek_disappeared"
} {
  const { bound, presented, presentedMatches, alreadyFlagged } = input

  // Nothing bound yet: bind the first value we see.
  if (bound == null || bound === "") {
    if (!presented) return { action: "noop" }
    return { action: "bind" }
  }

  if (presented && presentedMatches) return { action: "noop" }

  // The flag is set once and never cleared.
  if (alreadyFlagged) return { action: "noop" }

  return presented
    ? { action: "flag", reason: "bek_changed" }
    : { action: "flag", reason: "bek_disappeared" }
}

/**
 * Trust-on-first-use attestation for the SEB Browser Exam Key. Advisory only:
 * it flags the session for the teacher and never denies.
 *
 * Depends on Exam.sebExamKeySalt being pinned, or every relaunch would flag.
 */
async function attestBrowserExamKey(
  examId: string,
  examSession: SebGuardSession,
  presented: string | null
): Promise<void> {
  try {
    await attestBrowserExamKeyInner(examId, examSession, presented)
  } catch {
    // Advisory: never fail the request over it.
  }
}

async function attestBrowserExamKeyInner(
  examId: string,
  examSession: SebGuardSession,
  presented: string | null
): Promise<void> {
  const presentedOrEmpty = presented ?? ""
  const decision = decideBekAction({
    bound: examSession.sebBrowserExamKey,
    presented: presentedOrEmpty,
    presentedMatches:
      presentedOrEmpty !== "" &&
      examSession.sebBrowserExamKey !== null &&
      timingSafeEqualStr(examSession.sebBrowserExamKey, presentedOrEmpty),
    alreadyFlagged: examSession.sebIntegrityFlaggedAt !== null,
  })

  if (decision.action === "noop") return

  if (decision.action === "bind") {
    // Set-once, so a concurrent bind cannot overwrite the first value.
    await prisma.examSession.updateMany({
      where: {
        id: examSession.id,
        OR: [{ sebBrowserExamKey: null }, { sebBrowserExamKey: "" }],
      },
      data: { sebBrowserExamKey: presentedOrEmpty },
    })
    return
  }

  // Flag path: decideBekAction only returns "flag" alongside a reason.
  const reason = decision.reason as SebIntegrityReason

  // Guarded in the query so concurrent requests flag and publish only once.
  const { count } = await prisma.examSession.updateMany({
    where: { id: examSession.id, sebIntegrityFlaggedAt: null },
    data: { sebIntegrityFlaggedAt: new Date(), sebIntegrityReason: reason },
  })
  if (count === 0) return

  // The Go hub relays this to every connected monitor.
  try {
    await redis.publish(
      `exam:${examId}:monitor`,
      JSON.stringify({
        originId: "web",
        sessionId: examSession.id,
        patch: { sebIntegrityFlagged: true, sebIntegrityReason: reason },
      })
    )
  } catch {
    // The flag is already persisted; monitors pick it up on reconnect.
  }
}

// Denials where the bound token or UA no longer matches get their own audit
// action so they can be filtered separately.
const SEB_INTEGRITY_DENIAL_REASONS = new Set(["key_mismatch", "ua_mismatch"])

/**
 * Our own header for the Browser Exam Key, set by sebFetch. Not SEB's
 * `x-safeexambrowser-requesthash`, which Windows SEB rewrites per URL.
 *
 * Keep in sync with SEB_BEK_HEADER in lib/seb-client.ts.
 */
const SEB_BEK_HEADER = "x-openexam-seb-requesthash"

/** Records a SEB guard denial to the audit log (best-effort). */
async function logSebDenial(
  reason: string,
  params: {
    examId: string
    sessionId: string
    userId?: string
    ip?: string
    userAgent?: string
  }
): Promise<void> {
  await createAuditLog({
    action: SEB_INTEGRITY_DENIAL_REASONS.has(reason)
      ? "SEB_INTEGRITY_DENIED"
      : "SEB_ACCESS_DENIED",
    entityType: "ExamSession",
    entityId: params.sessionId,
    userId: params.userId,
    examId: params.examId,
    metadata: { reason },
    ipAddress: params.ip,
    userAgent: params.userAgent,
  })
}

/**
 * Fail-closed SEB enforcement, shared by the take page and every student
 * REST route. If `exam.sebRequired` is set, a request must present a valid
 * Config Key token.
 *
 * The token is accepted in two forms:
 *  - sha256(takePageURL + ConfigKey), from the SEB JS API (all platforms).
 *  - sha256(requestUrl + ConfigKey), from SEB's native header on Windows.
 *
 * Every denial is audit-logged.
 */
export async function verifySebAccess(params: {
  exam: SebGuardExam
  examSession: SebGuardSession
  headers: Headers
  requestUrl: string
  /** No REST route uses this anymore; the WS handshake now carries the
   * token as its first message. Kept as an escape hatch for tests/parity. */
  sebKeyParam?: string | null
  /** No REST route uses this anymore; the WS handshake now carries the
   * BEK as part of its first message. Kept for tests/parity. */
  bekKeyParam?: string | null
  /**
   * True for a top-level page navigation. Navigations cannot carry
   * SEB_BEK_HEADER, so they skip BEK attestation.
   */
  isNavigation?: boolean
  userId?: string
  ip?: string
}): Promise<SebGuardResult> {
  const result = await verifySebAccessInner(params)
  if (!result.ok) {
    await logSebDenial(result.reason, {
      examId: params.exam.id,
      sessionId: params.examSession.id,
      userId: params.userId,
      ip: params.ip,
      userAgent: params.headers.get("user-agent") ?? undefined,
    })
  }
  return result
}

async function verifySebAccessInner(params: {
  exam: SebGuardExam
  examSession: SebGuardSession
  headers: Headers
  requestUrl: string
  sebKeyParam?: string | null
  bekKeyParam?: string | null
  isNavigation?: boolean
}): Promise<SebGuardResult> {
  const {
    exam,
    examSession,
    headers,
    requestUrl,
    sebKeyParam,
    bekKeyParam,
    isNavigation,
  } = params

  if (!exam.sebRequired) return { ok: true }

  // Either the personalized key (auto-login config) or the exam's anonymous
  // key may authorize this session.
  const configKeys = [examSession.sebConfigKey, exam.sebConfigKey].filter(
    (key): key is string => !!key
  )
  if (configKeys.length === 0) {
    return { ok: false, reason: "seb_not_configured" }
  }

  const token =
    headers.get("x-safeexambrowser-configkeyhash") ?? sebKeyParam ?? null
  if (!token) return { ok: false, reason: "missing_token" }

  const expectedTakeUrl = takeUrl(exam.id)

  // Run every comparison, without short-circuiting, to keep timing constant.
  let matchedKey: string | null = null
  for (const configKey of configKeys) {
    const expectedT = configKeyTokenForUrl(expectedTakeUrl, configKey)
    const expectedPerUrl = configKeyTokenForUrl(requestUrl, configKey)
    if (timingSafeEqualStr(token, expectedT)) matchedKey ??= configKey
    if (timingSafeEqualStr(token, expectedPerUrl)) matchedKey ??= configKey
  }
  if (!matchedKey) return { ok: false, reason: "invalid_token" }

  // Bind the take-page token of the matched key, not the presented token:
  // Windows sends a different per-URL hash on every endpoint.
  const identityToken = configKeyTokenForUrl(expectedTakeUrl, matchedKey)

  const ua = headers.get("user-agent") ?? ""
  // `undefined` for a navigation (nothing observed); null means "absent".
  const bekToken = isNavigation
    ? undefined
    : (headers.get(SEB_BEK_HEADER) ?? bekKeyParam ?? null)

  if (!examSession.sebKeyHash) {
    // A rebind after a config reissue must come from the User-Agent on record.
    if (examSession.sebUserAgent && examSession.sebUserAgent !== ua) {
      return { ok: false, reason: "ua_mismatch" }
    }

    // Set-once bind, including the Browser Exam Key in the same write.
    const { count } = await prisma.examSession.updateMany({
      where: { id: examSession.id, sebKeyHash: null },
      data: {
        sebKeyHash: identityToken,
        sebUserAgent: ua,
        ...(bekToken ? { sebBrowserExamKey: bekToken } : {}),
      },
    })
    if (count > 0) return { ok: true }

    // Lost the race: compare against the values the winner bound.
    const settled = await prisma.examSession.findUnique({
      where: { id: examSession.id },
      select: {
        id: true,
        sebConfigKey: true,
        sebKeyHash: true,
        sebUserAgent: true,
        sebBrowserExamKey: true,
        sebIntegrityFlaggedAt: true,
      },
    })
    if (!settled?.sebKeyHash) {
      return { ok: false, reason: "key_mismatch" }
    }
    return compareAgainstBound(exam.id, settled, identityToken, ua, bekToken)
  }

  return compareAgainstBound(exam.id, examSession, identityToken, ua, bekToken)
}

/**
 * Verifies a presented token/UA pair against an already-bound session.
 * Fail-closed on mismatch; the Browser Exam Key check runs afterwards and
 * cannot change the verdict.
 */
async function compareAgainstBound(
  examId: string,
  bound: SebGuardSession,
  identityToken: string,
  ua: string,
  /** `undefined` skips attestation entirely — see `isNavigation`. */
  bekToken: string | null | undefined
): Promise<SebGuardResult> {
  if (
    !bound.sebKeyHash ||
    !timingSafeEqualStr(bound.sebKeyHash, identityToken)
  ) {
    return { ok: false, reason: "key_mismatch" }
  }
  if (bound.sebUserAgent !== ua) {
    return { ok: false, reason: "ua_mismatch" }
  }

  if (bekToken !== undefined) {
    await attestBrowserExamKey(examId, bound, bekToken)
  }
  return { ok: true }
}
