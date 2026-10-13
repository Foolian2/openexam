import { randomInt } from "node:crypto"

// 32-symbol alphabet (no I/O/0/1): 32^6 ≈ 1.07B codes.
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function generateAccessCode(): string {
  return Array.from({ length: 6 }, () => CHARS[randomInt(CHARS.length)]).join("")
}
