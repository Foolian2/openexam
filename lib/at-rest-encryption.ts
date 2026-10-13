import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto"

/**
 * AES-256-GCM encryption for secrets that must be stored at rest but only
 * ever need to exist in memory for a moment (OAuth tokens, the SEB emergency
 * quit password).
 *
 * The ciphertext format is versioned so plaintext rows from before this
 * module existed can still be read (and are returned unchanged):
 *
 *   enc:v1:<iv-b64url>.<authTag-b64url>.<ciphertext-b64url>
 *
 * The key is derived from AT_REST_ENC_KEY (SHA-256). Development/test
 * environments use a fixed key so local flows keep working without the
 * variable; production refuses to boot with an unset or short key — a
 * deployment that silently falls back to a guessable key would make the
 * encryption decoration, not protection.
 */

export const AT_REST_ENC_PREFIX = "enc:v1:"

function key(): Buffer {
  if (process.env.NODE_ENV !== "production") {
    return createHash("sha256").update("openexam-dev-at-rest-key").digest()
  }
  const raw = process.env.AT_REST_ENC_KEY
  if (!raw || raw.length < 32) {
    throw new Error(
      "AT_REST_ENC_KEY must be set to a random value of at least 32 characters in production (openssl rand -base64 32)"
    )
  }
  return createHash("sha256").update(raw).digest()
}

const GCM_TAG_LENGTH = 16

/** Encrypts a string; the result is safe to store in a TEXT column. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv, {
    authTagLength: GCM_TAG_LENGTH,
  })
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    AT_REST_ENC_PREFIX,
    iv.toString("base64url"),
    ".",
    tag.toString("base64url"),
    ".",
    ciphertext.toString("base64url"),
  ].join("")
}

/**
 * Decrypts a value produced by encryptSecret. Values without the version
 * prefix (legacy plaintext rows) are returned unchanged.
 */
export function decryptSecret(value: string): string {
  if (!value.startsWith(AT_REST_ENC_PREFIX)) return value
  const body = value.slice(AT_REST_ENC_PREFIX.length)
  const ivB64 = body.slice(0, body.indexOf("."))
  const rest = body.slice(body.indexOf(".") + 1)
  const tagB64 = rest.slice(0, rest.indexOf("."))
  const dataB64 = rest.slice(rest.indexOf(".") + 1)
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64url"),
    { authTagLength: GCM_TAG_LENGTH }
  )
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(AT_REST_ENC_PREFIX)
}
