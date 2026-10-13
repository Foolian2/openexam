/**
 * FILE_UPLOAD answers store a file key (the AnswerFile primary key), and that
 * key is dereferenced server-side to serve the file. The key therefore has to be
 * treated as untrusted input on the way in and on the way out: it arrives in
 * `Answer.content`, which the student writes through the autosave endpoint
 * (REST and WS), so nothing about it is guaranteed just because a row exists.
 *
 * Keys are minted in exactly one place — app/api/sessions/[id]/upload — and
 * always have the shape:
 *
 *     sessions/{sessionId}/{questionId}/{uuid}{ext}
 *
 * Both the writer and the reader validate against that shape *and* against the
 * session/question the request is actually for, so a student cannot point their
 * own answer row at another session's object (or at anything else in the
 * bucket) and have the server sign it for them.
 */

/** Extension as produced by the upload route: lowercase, dot-prefixed, no separators. */
export const FILE_EXTENSION_RE = /^\.[a-z0-9]{1,16}$/

/** The random per-upload filename: a v4 UUID plus an extension. */
export const FILE_NAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$/

/**
 * Shape-only check, for schema validation where the session and question ids
 * aren't in scope yet. Rejects traversal, absolute keys and anything that isn't
 * a key this app could have minted — but says nothing about *whose* key it is.
 * Callers that know the session must use {@link fileKeyBelongsTo} instead.
 */
export const FILE_KEY_RE =
  /^sessions\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$/

export function buildFileKey(
  sessionId: string,
  questionId: string,
  fileId: string,
  ext: string
): string {
  return `sessions/${sessionId}/${questionId}/${fileId}${ext}`
}

/**
 * True only if `fileKey` is a well-formed upload key for exactly this session
 * and question. This is the authorization check — `FILE_KEY_RE` alone would
 * still admit another student's key.
 */
export function fileKeyBelongsTo(
  fileKey: string,
  sessionId: string,
  questionId: string
): boolean {
  const parts = fileKey.split("/")
  if (parts.length !== 4) return false
  const [prefix, keySessionId, keyQuestionId, fileName] = parts
  return (
    prefix === "sessions" &&
    keySessionId === sessionId &&
    keyQuestionId === questionId &&
    FILE_NAME_RE.test(fileName)
  )
}
