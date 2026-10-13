import { randomBytes } from "node:crypto"

/**
 * 32 hex chars (128 bits of entropy) — unguessable by construction. Scoped to
 * a single bank item, so a leaked token only exposes that one question.
 */
export function generateShareToken(): string {
  return randomBytes(16).toString("hex")
}
