/**
 * Regenerates lib/seb-default-root-settings.json from the seb-mac source of
 * truth (SEBSettings.m, -defaultSEBSettings, the "rootSettings" entry).
 *
 * Why this exists: SEB's Config Key is a hash over its FULL local settings
 * dictionary — every default preference plus whatever the loaded .seb file
 * overrides — not just the overridden keys (see SEBCryptor.m
 * -updateConfigKey / dictionaryRepresentationSEB, which reads every
 * org_safeexambrowser_SEB_* key from NSUserDefaults after defaults have
 * been merged in). Our server only ever knew about the ~20 keys it
 * customizes, so its Config Key could never match SEB's. This script pulls
 * SEB's own default dictionary out of its Objective-C source so
 * lib/seb-key.ts can hash the same full dictionary SEB does.
 *
 * Re-run this whenever seb-mac's SEBSettings.m changes (new SEB version),
 * then `pnpm seb:regenerate-keys` to refresh every exam's stored Config Key.
 *
 * Usage:
 *   pnpm seb:sync-defaults [path-to-seb-mac-checkout]
 *
 * Defaults to seb/seb-mac inside this repo (git-ignored) if no path is
 * given: git clone https://github.com/SafeExamBrowser/seb-mac seb/seb-mac
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sebMacRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "../seb/seb-mac")

const settingsFile = path.join(sebMacRoot, "Classes/ConfigFiles/SEBSettings.m")
const outFile = path.resolve(__dirname, "../lib/seb-default-root-settings.json")

// ---- 1. Build a symbol table for named constants (NS_ENUM members, #define, static consts) ----

function listHeaders(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listHeaders(full))
    else if (entry.endsWith(".h")) out.push(full)
  }
  return out
}

/**
 * A naive `line.indexOf("//")` truncates string literals like
 * `@"https://safeexambrowser.org/start"` at the URL's own "//" — this has to
 * track whether it's inside a string before treating "//" as a comment.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let inString = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (inString) {
          if (ch === "\\") i++
          else if (ch === '"') inString = false
          continue
        }
        if (ch === '"') {
          inString = true
          continue
        }
        if (ch === "/" && line[i + 1] === "/") return line.slice(0, i)
      }
      return line
    })
    .join("\n")
}

/**
 * We only ever launch students through the macOS release build, so
 * conditionals in the settings literal (DEBUG-only overrides,
 * TARGET_OS_OSX vs iOS branches) are resolved for that target rather than
 * genuinely evaluated. Only single-level #if/#ifdef/#ifndef...#else...#endif
 * is supported — that's everything SEBSettings.m currently uses.
 */
const PREPROCESSOR_DEFINES: Record<string, boolean> = {
  DEBUG: false,
  TARGET_OS_OSX: true,
  TARGET_OS_IOS: false,
  TARGET_OS_IPHONE: false,
}

function applyPreprocessor(src: string): string {
  const out: string[] = []
  const stack: { taking: boolean }[] = []
  const isActive = () => stack.every((s) => s.taking)

  for (const line of src.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith("#ifdef")) {
      stack.push({ taking: !!PREPROCESSOR_DEFINES[trimmed.replace("#ifdef", "").trim()] })
      continue
    }
    if (trimmed.startsWith("#ifndef")) {
      stack.push({ taking: !PREPROCESSOR_DEFINES[trimmed.replace("#ifndef", "").trim()] })
      continue
    }
    if (trimmed.startsWith("#if")) {
      const expr = trimmed.replace(/^#if\s*/, "")
      const cond = Object.keys(PREPROCESSOR_DEFINES).some(
        (name) => expr.includes(name) && PREPROCESSOR_DEFINES[name]
      )
      stack.push({ taking: cond })
      continue
    }
    if (trimmed.startsWith("#else")) {
      if (stack.length) stack[stack.length - 1].taking = !stack[stack.length - 1].taking
      continue
    }
    if (trimmed.startsWith("#endif")) {
      stack.pop()
      continue
    }
    // Any other line — including #define/#import/#pragma — passes through
    // the same active/inactive gate as regular content; only the five
    // control-flow directives above are consumed without emitting.
    if (isActive()) out.push(line)
  }
  return out.join("\n")
}

function readSource(file: string): string {
  return applyPreprocessor(stripLineComments(readFileSync(file, "utf8")))
}

/**
 * Enum members are frequently left without an explicit `= N` and rely on C's
 * auto-increment-from-previous rule, so this has to replay that rule rather
 * than just regex-matching `NAME = N` pairs.
 */
function buildSymbolTable(headers: string[]): Map<string, number | string> {
  const table = new Map<string, number | string>()

  for (const file of headers) {
    const src = readSource(file)

    const enumRe = /(?:typedef\s+)?(?:NS_ENUM\s*\([^)]*\)|NS_OPTIONS\s*\([^)]*\)|enum)\s*{([^}]*)}/g
    let m: RegExpExecArray | null
    while ((m = enumRe.exec(src))) {
      let current = 0
      for (const rawMember of m[1].split(",")) {
        const member = rawMember.trim()
        if (!member) continue
        const parsed = member.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(-?\d+))?$/)
        if (!parsed) continue
        const [, name, value] = parsed
        if (value !== undefined) current = parseInt(value, 10)
        table.set(name, current)
        current++
      }
    }

    for (const dm of src.matchAll(/#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(-?\d+(?:\.\d+)?)\b/g)) {
      if (!table.has(dm[1])) table.set(dm[1], parseFloat(dm[2]))
    }

    for (const sm of src.matchAll(
      /(?:static\s+)?(?:const\s+)?NS(?:U?Integer|\s*\*?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)\s*;/g
    )) {
      if (!table.has(sm[1])) table.set(sm[1], parseFloat(sm[2]))
    }

    // static NSString *NAME = @"..."; (also #define NAME @"...")
    for (const strm of src.matchAll(
      /(?:static\s+)?(?:const\s+)?NSString\s*(?:__unused\s+)?\*+\s*(?:__unused\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*@"((?:[^"\\]|\\.)*)"\s*;/g
    )) {
      if (!table.has(strm[1])) table.set(strm[1], strm[2].replace(/\\(.)/g, "$1"))
    }
    for (const strDm of src.matchAll(/#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+@"((?:[^"\\]|\\.)*)"/g)) {
      if (!table.has(strDm[1])) table.set(strDm[1], strDm[2].replace(/\\(.)/g, "$1"))
    }
  }

  return table
}

// ---- 2. Extract the "rootSettings" NSDictionary literal from defaultSEBSettings ----

function findMatchingBracket(src: string, openIdx: number): number {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "[") depth++
    else if (src[i] === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error("unbalanced brackets while scanning for dictionaryWithObjectsAndKeys: literal")
}

function extractRootSettingsBody(): string {
  const src = readSource(settingsFile)
  const methodIdx = src.indexOf("defaultSEBSettings")
  if (methodIdx === -1) throw new Error(`-defaultSEBSettings not found in ${settingsFile}`)
  const callIdx = src.indexOf("dictionaryWithObjectsAndKeys:", methodIdx)
  if (callIdx === -1) throw new Error("dictionaryWithObjectsAndKeys: not found after -defaultSEBSettings")
  const openIdx = src.lastIndexOf("[", callIdx)
  const closeIdx = findMatchingBracket(src, openIdx)
  return src.slice(callIdx + "dictionaryWithObjectsAndKeys:".length, closeIdx)
}

// ---- 3. Tokenize the flat value,key,value,key,...,nil list at top level ----

function splitTopLevel(body: string): string[] {
  const items: string[] = []
  let depth = 0
  let current = ""
  let inString = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inString) {
      current += ch
      if (ch === "\\" && i + 1 < body.length) {
        current += body[++i]
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      current += ch
      continue
    }
    if (ch === "[" || ch === "(") depth++
    if (ch === "]" || ch === ")") depth--
    if (ch === "," && depth === 0) {
      items.push(current.trim())
      current = ""
      continue
    }
    current += ch
  }
  if (current.trim()) items.push(current.trim())
  return items.filter((i) => i.length > 0 && i !== "nil")
}

function parseValue(token: string, symbols: Map<string, number | string>): unknown {
  if (token === "@YES") return true
  if (token === "@NO") return false
  if (token.startsWith('@"')) {
    return token.slice(2, -1).replace(/\\(.)/g, "$1")
  }
  if (/^@-?\d+(\.\d+)?$/.test(token)) return Number(token.slice(1))

  const numMatch = token.match(
    /^\[NSNumber numberWith(?:Long|LongLong|Int|Integer|UnsignedInteger|Short|Bool|Double|Float):\s*(.+)\]$/
  )
  if (numMatch) {
    let expr = numMatch[1].trim()
    // Strip a leading C-style cast, e.g. "(NSInteger)3".
    expr = expr.replace(/^\([A-Za-z_][A-Za-z0-9_ ]*\)\s*/, "")
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr)
    if (expr === "YES") return true
    if (expr === "NO") return false
    if (symbols.has(expr)) return symbols.get(expr)
    throw new Error(`Unresolved symbol "${expr}" in ${token} — add its header to the scan or hardcode it`)
  }

  if (token === "[NSArray array]" || token === "@[]") return []
  // Empty NSData — the canonical serialization base64-encodes binary data,
  // and base64 of zero bytes is the empty string.
  if (token === "[NSData data]") return ""
  if (token === "[NSMutableDictionary new]" || token === "[NSDictionary dictionary]" || token === "@{}") return {}

  // A bare identifier referencing a static NSString*/#define constant, e.g.
  // `SEBStartPage,` used directly as a value (not wrapped in @"...").
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && symbols.has(token)) {
    return symbols.get(token)
  }

  throw new Error(`Unrecognized value literal: ${token}`)
}

function main() {
  const headers = listHeaders(path.join(sebMacRoot, "Classes"))
  const symbols = buildSymbolTable(headers)

  const body = extractRootSettingsBody()
  const items = splitTopLevel(body)
  if (items.length % 2 !== 0) {
    throw new Error(`Expected an even number of value/key items in rootSettings, got ${items.length}`)
  }

  const settings: Record<string, unknown> = {}
  for (let i = 0; i < items.length; i += 2) {
    const valueToken = items[i]
    const keyToken = items[i + 1]
    if (!keyToken.startsWith('@"')) {
      throw new Error(`Expected a string key at item ${i + 1}, got: ${keyToken}`)
    }
    const key = parseValue(keyToken, symbols) as string
    settings[key] = parseValue(valueToken, symbols)
  }

  const sortedKeys = Object.keys(settings).sort()
  writeFileSync(outFile, JSON.stringify(settings, sortedKeys, 2) + "\n")
  console.log(
    `Wrote ${sortedKeys.length} default rootSettings keys to ${path.relative(process.cwd(), outFile)}\n` +
      `Source: ${path.relative(process.cwd(), settingsFile)}\n\n` +
      `Next: run 'pnpm seb:regenerate-keys' to refresh every exam's stored Config Key.`
  )
}

main()
