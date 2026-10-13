import { randomBytes } from "node:crypto"
import { redis } from "@/lib/redis"

const KEY_PREFIX = "seb:lt:"

/**
 * Lifetime of a launch token, in seconds.
 *
 * Exported because lib/auth.ts pins the one-time login token's expiry to the
 * same window: the two are minted together and travel on the same seb:// link,
 * so a shorter TTL on either would open a gap where the link still resolves
 * but the auto-login inside SEB silently falls back to a manual login.
 */
export const LAUNCH_TOKEN_TTL_SECONDS = 300

export interface LaunchTokenPayload {
  userId: string
  examId: string
}

interface StoredPayload extends LaunchTokenPayload {
  v: 1
}

function encode(payload: LaunchTokenPayload): string {
  const stored: StoredPayload = { v: 1, userId: payload.userId, examId: payload.examId }
  return JSON.stringify(stored)
}

function decode(value: string): StoredPayload | null {
  try {
    const parsed = JSON.parse(value) as StoredPayload
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.userId !== "string" ||
      typeof parsed.examId !== "string"
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function mintLaunchToken(payload: LaunchTokenPayload): Promise<string> {
  const token = randomBytes(32).toString("hex")
  await redis.set(
    KEY_PREFIX + token,
    encode(payload),
    "EX",
    LAUNCH_TOKEN_TTL_SECONDS
  )
  return token
}

export async function consumeLaunchToken(
  token: string,
  examId: string
): Promise<LaunchTokenPayload | null> {
  if (!token) return null
  const key = KEY_PREFIX + token

  const raw = await redis.getdel(key)

  if (!raw) return null
  const parsed = decode(raw)
  if (!parsed) return null
  if (parsed.examId !== examId) return null

  return { userId: parsed.userId, examId: parsed.examId }
}

/**
 * Non-destructive check for whether a launch token is still valid — unlike
 * consumeLaunchToken, this does NOT delete it. SEB always issues a HEAD
 * request before the real GET when resolving a seb:// link (confirmed in
 * prod nginx logs: HEAD 200 immediately followed by GET 401); Next.js
 * auto-generates a HEAD handler from GET when none is exported, which would
 * otherwise run consumeLaunchToken and burn the single-use token before the
 * real GET ever arrives. Route HEAD requests through this instead.
 */
export async function peekLaunchToken(
  token: string,
  examId: string
): Promise<boolean> {
  if (!token) return false
  const raw = await redis.get(KEY_PREFIX + token)
  if (!raw) return false
  const parsed = decode(raw)
  return parsed !== null && parsed.examId === examId
}