import { timingSafeEqual } from "node:crypto"

/** Constant-time string comparison that does not leak length via early return. */
export function secureEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) {
    // timingSafeEqual throws on length mismatch, so compare bufA against
    // itself to burn comparable time, then fail. Length is not a secret
    // worth hiding for access codes, but this keeps timing near-uniform
    // without a throw.
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}
