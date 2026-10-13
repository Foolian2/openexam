import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  AUDIT_ACTION_LABELS,
  EXAM_SCOPED_AUDIT_ACTIONS,
} from "@/lib/audit-actions"

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

// Where an audit row's action is set:
// - directly in createAuditLog({ action: … })
// - in the `audit: { action: … }` object handed to finalizeSession, which
//   forwards it (lib/finalize-session.ts)
// Ternaries (`locked ? "SESSION_LOCKED" : "SESSION_UNLOCKED"`) are covered.
// `[^{}]*?` stops at the first nested object, so a bulk grade's
// metadata.action ("SET_POINTS") is not mistaken for the row's action.
const ACTION_SITES = [
  /createAuditLog\(\s*\{[^{}]*?\baction:\s*([^,\n]+(?:\n\s*[?:][^,\n]+)*)/g,
  /\baudit:\s*\{[^{}]*?\baction:\s*([^,\n]+(?:\n\s*[?:][^,\n]+)*)/g,
]

function writtenActions(): Set<string> {
  const files = [...sourceFiles("app"), ...sourceFiles("lib")]
  const sources = files.map((file) => readFileSync(file, "utf8"))

  // Constants an action may be passed as (e.g. PRIVACY_ACCEPTED_AUDIT_ACTION).
  const constants = new Map<string, string>()
  for (const src of sources) {
    for (const m of src.matchAll(
      /\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*"([A-Z][A-Z_]+)"/g
    )) {
      constants.set(m[1], m[2])
    }
  }

  const found = new Set<string>()
  const unresolved: string[] = []
  for (const src of sources) {
    for (const site of ACTION_SITES) {
      for (const m of src.matchAll(site)) {
        const expr = m[1]
        const literals = [...expr.matchAll(/"([A-Z][A-Z_]+)"/g)]
        for (const a of literals) found.add(a[1])
        for (const id of expr.matchAll(/\b([A-Z][A-Z0-9_]*)\b(?!")/g)) {
          const value = constants.get(id[1])
          if (value) found.add(value)
        }
        // Anything else (e.g. `input.audit.action` inside finalizeSession)
        // must be a pass-through whose callers are scanned above.
        if (!literals.length && !/\b[A-Z][A-Z0-9_]*\b/.test(expr)) {
          unresolved.push(expr.trim())
        }
      }
    }
  }
  expect(unresolved.every((e) => /^input\.audit\.action$/.test(e))).toBe(true)
  return found
}

describe("audit action labels", () => {
  it("finds the actions in the source (guards the scan itself)", () => {
    const actions = writtenActions()
    expect(actions.has("EXAM_CREATED")).toBe(true)
    expect(actions.has("SESSION_UNLOCKED")).toBe(true)
    expect(actions.has("SET_POINTS")).toBe(false)
    // via a constant and via finalizeSession's audit object
    expect(actions.has("PRIVACY_POLICY_ACCEPTED")).toBe(true)
    expect(actions.has("SESSION_SUBMITTED")).toBe(true)
  })

  it("has a German label for every action the app writes", () => {
    const missing = [...writtenActions()].filter(
      (a) => !(a in AUDIT_ACTION_LABELS)
    )
    expect(missing).toEqual([])
  })

  it("offers only labelled actions in the teacher filter", () => {
    for (const a of EXAM_SCOPED_AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_LABELS[a]).toBeTruthy()
    }
  })
})
