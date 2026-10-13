import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"

export type SebSecretStore = Pick<Prisma.TransactionClient, "exam">
import { generateQuitPassword, generateExamKeySalt } from "@/lib/seb-config"
import { decryptSecret, encryptSecret } from "@/lib/at-rest-encryption"

/**
 * Returns the exam's emergency-override password, generating and persisting one
 * on first use. It feeds the Config Key, so it must never change once a .seb
 * file is out; the conditional `updateMany` plus re-read makes concurrent
 * callers agree on one value.
 *
 * Stored encrypted at rest (lib/at-rest-encryption.ts). Legacy plaintext rows
 * are re-encrypted on the next call.
 */
export async function ensureSebQuitPassword(
  examId: string,
  store: SebSecretStore = prisma
): Promise<string> {
  const exam = await store.exam.findUnique({
    where: { id: examId },
    select: { sebQuitPassword: true },
  })
  if (exam?.sebQuitPassword) {
    const plaintext = decryptSecret(exam.sebQuitPassword)
    // Best-effort re-encryption of a legacy plaintext row.
    if (!exam.sebQuitPassword.startsWith("enc:v1:")) {
      await store.exam
        .updateMany({
          where: { id: examId, sebQuitPassword: exam.sebQuitPassword },
          data: { sebQuitPassword: encryptSecret(plaintext) },
        })
        .catch(() => {})
    }
    return plaintext
  }

  await store.exam.updateMany({
    where: { id: examId, sebQuitPassword: null },
    data: { sebQuitPassword: encryptSecret(generateQuitPassword()) },
  })

  const settled = await store.exam.findUnique({
    where: { id: examId },
    select: { sebQuitPassword: true },
  })
  if (!settled?.sebQuitPassword) {
    throw new Error(`seb: could not persist a quit password for exam ${examId}`)
  }
  return decryptSecret(settled.sebQuitPassword)
}

/**
 * Returns the exam's `examKeySalt`, generating and persisting one on first use,
 * or null for an exam whose Config Key was frozen before salts existed. Same
 * concurrency pattern as `ensureSebQuitPassword`.
 */
export async function ensureSebExamKeySalt(
  examId: string,
  store: SebSecretStore = prisma
): Promise<Buffer | null> {
  const exam = await store.exam.findUnique({
    where: { id: examId },
    select: { sebExamKeySalt: true, sebConfigKey: true },
  })
  if (exam?.sebExamKeySalt) return Buffer.from(exam.sebExamKeySalt)

  // Older exams with a frozen unsalted key stay unsalted.
  if (exam?.sebConfigKey) return null

  await store.exam.updateMany({
    // sebConfigKey: null guards the same invariant against a concurrent
    // activation that froze the key between our read and this write.
    where: { id: examId, sebExamKeySalt: null, sebConfigKey: null },
    // Prisma's Bytes type needs a Uint8Array, not a Buffer.
    data: { sebExamKeySalt: new Uint8Array(generateExamKeySalt()) },
  })

  const settled = await store.exam.findUnique({
    where: { id: examId },
    select: { sebExamKeySalt: true },
  })
  return settled?.sebExamKeySalt ? Buffer.from(settled.sebExamKeySalt) : null
}
