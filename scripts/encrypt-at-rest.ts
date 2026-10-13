/**
 * Re-wraps legacy plaintext at-rest secrets as AES-256-GCM ciphertext:
 *
 *   - Account.accessToken / refreshToken / idToken (OAuth tokens)
 *   - Exam.sebQuitPassword
 *
 * Runs safely on every boot/upgrade: rows already carrying the `enc:v1:`
 * prefix are skipped, and everything else is encrypted in place. Intended to
 * be run once after deploying the at-rest encryption change, on a database
 * that predates it:
 *
 *   pnpm tsx scripts/encrypt-at-rest.ts
 *
 * Requires AT_REST_ENC_KEY to be set when NODE_ENV=production
 * (lib/at-rest-encryption.ts enforces this).
 */
import { prisma } from "@/lib/prisma"
import { TOKEN_FIELDS } from "@/lib/encrypted-prisma-adapter"
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "@/lib/at-rest-encryption"

async function main() {
  // ── OAuth tokens ──────────────────────────────────────────────────────────
  const accounts = await prisma.account.findMany({
    select: { id: true, accessToken: true, refreshToken: true, idToken: true },
  })
  let accountRows = 0
  for (const account of accounts) {
    const next = { ...account }
    let changed = false
    for (const field of TOKEN_FIELDS) {
      const value = account[field]
      if (
        typeof value === "string" &&
        value !== "" &&
        !isEncryptedSecret(value)
      ) {
        next[field] = encryptSecret(decryptSecret(value))
        changed = true
      }
    }
    if (changed) {
      await prisma.account.update({
        where: { id: account.id },
        data: {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          idToken: next.idToken,
        },
      })
      accountRows++
    }
  }

  // ── SEB quit passwords ────────────────────────────────────────────────────
  const exams = await prisma.exam.findMany({
    where: { sebQuitPassword: { not: null } },
    select: { id: true, sebQuitPassword: true },
  })
  let examRows = 0
  for (const exam of exams) {
    if (!exam.sebQuitPassword || isEncryptedSecret(exam.sebQuitPassword))
      continue
    await prisma.exam.update({
      where: { id: exam.id },
      data: {
        sebQuitPassword: encryptSecret(decryptSecret(exam.sebQuitPassword)),
      },
    })
    examRows++
  }

  console.log(
    `encrypt-at-rest: re-encrypted ${accountRows} account rows and ${examRows} exam rows`
  )
}

main()
  .catch((err) => {
    console.error("encrypt-at-rest failed:", err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
