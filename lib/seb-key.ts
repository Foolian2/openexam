import { createHash } from "node:crypto"

/**
 * Implements the SEB Config Key algorithm from the official spec
 * (https://safeexambrowser.org/developer/seb-config-key.html): serialize the
 * settings dict to a canonical "SEB-JSON" string, then SHA256 it.
 *
 * This is deliberately not JSON.stringify — the spec's canonical form sorts
 * every dict's keys case-insensitively, drops `originatorVersion` and empty
 * dicts, and (unlike JSON) does not escape strings.
 */

// Accepts any plist-shaped value (string/number/boolean/Date/Buffer/array/
// dict) at the type level; unsupported runtime values throw in
// serializeValue. Kept loose so callers can pass a plist.PlistObject
// directly without a structural cast.
type SebValue = unknown

function isPlainObject(v: unknown): v is Record<string, SebValue> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    // Buffers are plist <data>, not dicts. serializeDict branches on this to
    // decide whether to recurse, so excluding Buffer here is what keeps a
    // binary value out of the dict path in *both* callers.
    !Buffer.isBuffer(v)
  )
}

/**
 * SEB macOS 43ba8c54 (SEBCryptor.m) and Windows 016d2341
 * (ConfigurationData/Json.cs) wrap strings without JSON escaping. Their
 * validators reject a quote followed by optional whitespace and a comma,
 * recursively in keys and values, to prevent Config Key serialization collisions.
 * Match both rules: escaping accepted strings would produce a different key,
 * while emitting the forbidden sequence could hash different settings alike.
 */
function serializeString(s: string): string {
  // ICU (macOS) and .NET \s include Unicode whitespace such as U+0085,
  // which JavaScript's \s omits. Use the Unicode property to match both.
  if (/"\p{White_Space}*,/u.test(s)) {
    throw new Error(
      "seb-key: setting contains a double quote followed by a comma"
    )
  }
  return '"' + s + '"'
}

/**
 * plist <integer> stays integral; plist <real> keeps its fractional part,
 * "rounded correctly" per the spec — i.e. the shortest decimal that round-trips
 * (0.10000000000000001 serializes as 0.1), which is exactly what JS number
 * stringification already produces.
 *
 * This used to be `String(Math.round(value))`, which silently turned any real
 * into an integer. Nothing in buildSebSettings emits a real today, so it never
 * fired — but SEB 3.7 had to fix macOS and Windows disagreeing on precisely this
 * serialization (zoom levels, battery thresholds, the screen-proctoring
 * downscale factor), and a Config Key that disagrees with the client's denies
 * every student on the exam. Rounding was the one behaviour guaranteed to be
 * wrong for those values.
 *
 * Exponent notation is refused rather than guessed at: no SEB setting is that
 * large or small, and SEB's own formatters never produce it, so a value that
 * reaches here in that form means the caller is wrong.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `seb-key: non-finite number ${value} has no plist representation`
    )
  }
  const out = String(value)
  if (out.includes("e") || out.includes("E")) {
    throw new Error(
      `seb-key: number ${out} serializes in exponent notation, which SEB never emits`
    )
  }
  return out
}

function serializeValue(value: SebValue): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return serializeNumber(value)
  if (typeof value === "string") return serializeString(value)
  // Binary (plist <data>, e.g. examKeySalt) serializes as its base64 string —
  // and empty data as "", not as the base64 of nothing. See seb-mac
  // SEBCryptor.m jsonStringForObject. MUST precede the isPlainObject check: a
  // Buffer satisfies it, and would otherwise be emitted as a dict of byte
  // indices, silently desynchronizing our Config Key from SEB's.
  if (Buffer.isBuffer(value)) {
    return value.length === 0 ? '""' : serializeString(value.toString("base64"))
  }
  if (Array.isArray(value))
    return "[" + value.map(serializeValue).join(",") + "]"
  if (isPlainObject(value)) return serializeDict(value)
  throw new Error(`seb-key: unsupported value type ${typeof value}`)
}

function serializeDict(dict: Record<string, SebValue>): string {
  const entries: [string, string][] = []
  for (const [key, raw] of Object.entries(dict)) {
    if (key === "originatorVersion") continue
    if (isPlainObject(raw)) {
      const serialized = serializeDict(raw)
      if (serialized === "{}") continue // drop empty dicts, recursively
      entries.push([key, serialized])
    } else {
      entries.push([key, serializeValue(raw)])
    }
  }
  entries.sort((a, b) => {
    const la = a[0].toLowerCase()
    const lb = b[0].toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  return (
    "{" + entries.map(([k, v]) => serializeString(k) + ":" + v).join(",") + "}"
  )
}

/** SHA256 (hex) of the SEB-JSON canonicalization of `settings`. */
export function computeConfigKey(settings: Record<string, SebValue>): string {
  const canonical = serializeDict(settings)
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/**
 * The token SEB's JS API (`SafeExamBrowser.security.configKey`) and its
 * native per-URL header both compute: sha256(urlWithoutFragment + configKey).
 */
export function configKeyTokenForUrl(url: string, configKey: string): string {
  const urlNoFragment = url.split("#")[0]
  return createHash("sha256")
    .update(urlNoFragment + configKey, "utf8")
    .digest("hex")
}
