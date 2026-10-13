import { afterEach, describe, expect, it } from "vitest"
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from "@/lib/at-rest-encryption"

const ORIGINAL_ENV = { ...process.env }

// NODE_ENV is typed read-only on process.env; reassigning the whole object
// (as other tests in this suite, e.g. env.test.ts, already do) sidesteps that.
function setEnv(overrides: Record<string, string | undefined>) {
  const next: Record<string, string | undefined> = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  process.env = next as unknown as NodeJS.ProcessEnv
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("at-rest encryption", () => {
  it("round-trips a secret", () => {
    const plaintext = "super-secret-value"
    const stored = encryptSecret(plaintext)

    expect(stored.startsWith("enc:v1:")).toBe(true)
    expect(stored).not.toContain(plaintext)
    expect(decryptSecret(stored)).toBe(plaintext)
  })

  it("produces a fresh ciphertext per call (random IV)", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"))
  })

  it("passes legacy plaintext through unchanged", () => {
    expect(decryptSecret("LEGACY")).toBe("LEGACY")
    expect(isEncryptedSecret("LEGACY")).toBe(false)
    expect(isEncryptedSecret("enc:v1:whatever")).toBe(true)
  })

  it("detects tampering", () => {
    const stored = encryptSecret("do-not-touch")
    const tampered = stored.slice(0, -1) + (stored.endsWith("a") ? "b" : "a")
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it("encrypts empty strings deterministically enough to round-trip", () => {
    // The wrapper skips empty strings; the module itself must still
    // round-trip them so a future caller can't produce unreadable rows.
    expect(decryptSecret(encryptSecret(""))).toBe("")
  })

  describe("key() in production", () => {
    // key() reads process.env fresh on every call (no module-level caching),
    // so these can mutate process.env directly without vi.resetModules.

    it("throws when AT_REST_ENC_KEY is unset", () => {
      setEnv({ NODE_ENV: "production", AT_REST_ENC_KEY: undefined })
      expect(() => encryptSecret("x")).toThrow(/AT_REST_ENC_KEY must be set/)
    })

    it("throws when AT_REST_ENC_KEY is shorter than 32 characters", () => {
      setEnv({ NODE_ENV: "production", AT_REST_ENC_KEY: "x".repeat(31) })
      expect(() => encryptSecret("x")).toThrow(/AT_REST_ENC_KEY must be set/)
    })

    it("does not throw, and round-trips, with a valid 32+ char key", () => {
      setEnv({ NODE_ENV: "production", AT_REST_ENC_KEY: "x".repeat(32) })
      const stored = encryptSecret("prod-secret")
      expect(stored.startsWith("enc:v1:")).toBe(true)
      expect(decryptSecret(stored)).toBe("prod-secret")
    })

    it("falls back to the fixed dev key outside production even if AT_REST_ENC_KEY is unset", () => {
      setEnv({ NODE_ENV: "test", AT_REST_ENC_KEY: undefined })
      expect(() => encryptSecret("x")).not.toThrow()
    })
  })
})
