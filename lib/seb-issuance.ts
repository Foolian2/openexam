import { prisma } from "@/lib/prisma"
import {
  generateSebConfig,
  type GeneratedSebConfig,
  type SebExamInput,
} from "@/lib/seb-config"
import { sebBaseUrl } from "@/lib/seb-urls"
import {
  ensureSebQuitPassword,
  ensureSebExamKeySalt,
  type SebSecretStore,
} from "@/lib/seb-secrets"
import { isOpen, isWaiting } from "@/lib/session-state"
import { createAuditLog } from "@/lib/audit"

/**
 * SEB config issuance: the one place that turns an exam into a .seb file and
 * computes a Config Key. Everything goes through `resolveSebSettings`, so the
 * key always matches the persisted one that `verifySebAccess` checks against.
 */

/** The exam fields every Config-Key site needs. */
export type SebConfigExam = {
  id: string
  allowSpellCheck: boolean
}

/**
 * Resolves the persisted secrets and returns the settings dict every Config Key
 * on this exam must be computed from. The `ensure*` helpers generate the
 * secrets on first use and are safe under concurrency.
 */
async function resolveSebSettings(
  exam: SebConfigExam,
  store: SebSecretStore = prisma
): Promise<SebExamInput> {
  const quitPassword = await ensureSebQuitPassword(exam.id, store)
  const examKeySalt = await ensureSebExamKeySalt(exam.id, store)
  return {
    id: exam.id,
    allowSpellCheck: exam.allowSpellCheck,
    quitPassword,
    examKeySalt,
  }
}

/**
 * The exam-level (anonymous) Config Key, for the sites that need the key but
 * not the file: activation and the key-rotation script.
 *
 * `baseUrl` defaults to `sebBaseUrl()`; the rotation script passes
 * `requireSebBaseUrl()`'s result, which throws rather than falling back to
 * localhost when the env var is unset.
 */
export async function computeSebConfigKey(
  exam: SebConfigExam,
  baseUrl: string = sebBaseUrl(),
  store: SebSecretStore = prisma
): Promise<string> {
  const settings = await resolveSebSettings(exam, store)
  return generateSebConfig(settings, baseUrl).configKey
}

export type SebIssuanceInput = {
  examId: string
  /** The identity the transport resolved: a session cookie or a launch token. */
  userId: string
  /**
   * One-time login token for the personalized config's startURL (see
   * app/exam/[id]/seb-enter/route.ts). Only set on the seb:// path; a
   * downloaded .seb file must never contain one.
   */
  loginToken: string | null
  /** Audit context; the audit row is written here. */
  ipAddress?: string
  userAgent?: string
  launchTokenUsed: boolean
}

/**
 * `not_available` deliberately covers every "not eligible" case with one 404.
 */
export type SebIssuanceResult =
  | { ok: true; examId: string; file: Buffer }
  | { ok: false; reason: "not_available" | "key_drift" }

type SebEligibility =
  | { ok: false }
  | {
      ok: true
      exam: NonNullable<Awaited<ReturnType<typeof prisma.exam.findUnique>>>
      sessionIdToPersonalize: string | null
    }

/**
 * Who may obtain SEB launch material for an exam: its creator (preview), a
 * student with an open session in an ACTIVE SEB exam, or a student waiting in
 * the waiting room of a PUBLISHED shared-start SEB exam. Shared by config
 * issuance and the launch page so the two can never disagree about who gets
 * token state minted for them.
 */
async function resolveSebEligibility(
  examId: string,
  userId: string
): Promise<SebEligibility> {
  const exam = await prisma.exam.findUnique({ where: { id: examId } })
  if (!exam || !exam.sebRequired) return { ok: false }

  // Creator previews stay anonymous: a teacher has no ExamSession to bind a
  // login token to, and baking one into a config they may hand around would
  // be a standing credential for their own account.
  if (exam.creatorId === userId) {
    return { ok: true, exam, sessionIdToPersonalize: null }
  }
  if (exam.status !== "ACTIVE" && exam.status !== "PUBLISHED") {
    return { ok: false }
  }

  const examSession = await prisma.examSession.findUnique({
    where: { examId_userId: { examId, userId } },
    select: { id: true, status: true },
  })
  // A shared-start exam's waiting room already runs inside SEB, so a WAITING
  // session in its still-PUBLISHED exam qualifies too; Start then happens
  // inside the same SEB window.
  const eligible =
    exam.status === "ACTIVE"
      ? examSession && isOpen(examSession.status)
      : examSession && exam.waitingRoom && isWaiting(examSession.status)
  if (!examSession || !eligible) return { ok: false }
  // Set for students only: the session whose personalized Config Key the
  // issuance stores.
  return { ok: true, exam, sessionIdToPersonalize: examSession.id }
}

/** Whether `userId` may launch SEB for `examId` (see resolveSebEligibility). */
export async function canLaunchSeb(
  examId: string,
  userId: string
): Promise<boolean> {
  return (await resolveSebEligibility(examId, userId)).ok
}

/**
 * Issues a .seb config for `userId`, applying the full download policy:
 * eligibility, key freeze, per-session key rotation, and the audit row.
 *
 * Transport concerns stay with the caller: identity resolution (launch token
 * vs session cookie), rate limiting, and turning the result into an HTTP
 * response.
 */
export async function issueSebConfig(
  input: SebIssuanceInput
): Promise<SebIssuanceResult> {
  const { examId, userId, loginToken } = input

  const eligibility = await resolveSebEligibility(examId, userId)
  if (!eligibility.ok) return { ok: false, reason: "not_available" }
  const { exam, sessionIdToPersonalize } = eligibility

  const baseUrl = sebBaseUrl()
  const baseSettings = await resolveSebSettings(exam)
  const anonymousConfig = generateSebConfig(baseSettings, baseUrl)

  // A key that no longer matches the current profile needs
  // `pnpm seb:regenerate-keys`. Run it only between exam windows: it rotates
  // every key and invalidates all issued .seb files, so running it during an
  // active exam locks that cohort out.
  if (exam.sebConfigKey && anonymousConfig.configKey !== exam.sebConfigKey) {
    return { ok: false, reason: "key_drift" }
  }

  const generated: GeneratedSebConfig = generateSebConfig(
    {
      ...baseSettings,
      loginToken: sessionIdToPersonalize ? loginToken : null,
    },
    baseUrl
  )

  if (!exam.sebConfigKey) {
    // Freeze the exam-level key from the anonymous config, never the
    // personalized one. Conditional write for concurrent issuances.
    await prisma.exam.updateMany({
      where: { id: examId, sebConfigKey: null },
      data: { sebConfigKey: anonymousConfig.configKey },
    })
  }

  if (sessionIdToPersonalize && loginToken) {
    // sebKeyHash is cleared so SEB can rebind after a relaunch. sebUserAgent
    // is kept on purpose (see lib/seb-guard.ts). Last write wins.
    await prisma.examSession.update({
      where: { id: sessionIdToPersonalize },
      data: { sebConfigKey: generated.configKey, sebKeyHash: null },
    })
  }

  await createAuditLog({
    action: "SEB_CONFIG_DOWNLOADED",
    entityType: "Exam",
    entityId: exam.id,
    examId: exam.id,
    userId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: { launchTokenUsed: input.launchTokenUsed },
  })

  return { ok: true, examId: exam.id, file: generated.file }
}
