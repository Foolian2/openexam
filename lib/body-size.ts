import { NextRequest, NextResponse } from "next/server"
import { apiError } from "@/lib/api-response"

/**
 * Byte ceilings for JSON request bodies, by payload shape.
 *
 * The App Router does not bound request bodies at all (unlike the Pages
 * Router's 1 MB default), so without an explicit cap the only limit is
 * nginx's client_max_body_size — 110 MB of JSON that the route would buffer
 * and parse before zod ever sees it.
 *
 * These are coarse abuse guards, not validation: zod still enforces the real
 * per-field limits and returns a precise 422. Each tier therefore sits well
 * above what its routes' schemas actually permit, so a legitimate request can
 * never trip it — a cap that rejects real work would be a worse bug than the
 * one it prevents.
 *
 * These are the defaults. A route whose body is genuinely a couple of fields
 * (a boolean, a minute count) may still pin its own tighter number; the tiers
 * exist so that no route ends up with *no* limit, not to stop one being
 * stricter than its tier.
 */
export const BODY_LIMITS = {
  /** A 6-char access code, a boolean, a single id, a minute count. */
  TINY: 4 * 1024,
  /** Names, id lists, reorder payloads, per-item metadata. */
  SMALL: 64 * 1024,
  /** Exam and question payloads, incl. rich-text question configs. */
  MEDIUM: 1024 * 1024,
  /**
   * Bulk free text: answer autosave (FILL_IN_THE_BLANK allows 200 blanks of
   * 2000 chars) and grade feedback (200 x 5000 chars). Question-bank
   * imports are client-batched below this limit because 100 individually
   * valid CODE questions can exceed it.
   */
  LARGE: 8 * 1024 * 1024,
} as const

function payloadTooLarge(): NextResponse {
  return apiError("PAYLOAD_TOO_LARGE", "Anfrage zu gross", 413)
}

/**
 * Reads a request body, giving up once more than `maxBytes` have actually
 * been read off the stream — Content-Length is only ever a client-supplied
 * hint (chunked or headerless requests omit it entirely), so the limit has to
 * be enforced against real bytes, not the header. Buffering first and
 * checking `byteLength` afterwards would let such a request make the server
 * hold everything up to nginx's client_max_body_size.
 *
 * Returns the bytes (empty for a missing body), or `null` if the stream
 * exceeded the limit (the stream is cancelled at that point).
 */
export async function readBoundedBytes(
  request: Request,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader()
  if (!reader) return new Uint8Array(0)

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Reads and parses a request body as JSON, with the byte limit enforced
 * while reading (see readBoundedBytes). Lightweight endpoints (a 6-char code,
 * a boolean, a minutes number) don't need Next.js's default 4 MiB body limit.
 *
 * Returns a 413 response if the stream exceeds the limit, or the parsed
 * object (`null` if the body is missing/not valid JSON/not an object) for
 * the caller to validate further (e.g. with zod).
 */
export async function readBoundedJson(
  request: NextRequest,
  maxBytes: number
): Promise<NextResponse | Record<string, unknown> | null> {
  if (!request.body) return null
  const bytes = await readBoundedBytes(request, maxBytes)
  if (bytes === null) return payloadTooLarge()

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
