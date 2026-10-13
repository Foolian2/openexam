import type { IntegrityEventKind } from "@/generated/prisma/client"

export type { IntegrityEventKind }

/**
 * The integrity-signal contract, shared by everything that touches the
 * allow-list.
 *
 * The single source of truth is the `IntegrityEventKind` DB enum
 * (prisma/schema.prisma). This module re-exports its type and pins two more
 * declarations to it:
 *
 * - `EXHAUSTIVE_KINDS` (`satisfies readonly IntegrityEventKind[]`) and the
 *   `INTEGRITY_KIND_LABELS` map (`Record<IntegrityEventKind, string>`) fail
 *   to compile if a DB enum member is ever added or renamed without updating
 *   them here.
 * - `MONITOR_PATCH_KEYS` (`satisfies readonly (keyof MonitorSessionPatch)[]`)
 *   fails to compile if the known monitor patch keys drift from
 *   `MonitorSessionPatch`.
 *
 * testdata/integrity-event-vectors.json pins these declarations to the
 * runtime gate on the Go side (ws-backend/internal/protocol/messages.go's
 * `IntegrityEventKinds`) and to the keys ws-backend actually publishes in
 * monitor patches — see __tests__/integrity-event-contract.test.ts and
 * ws-backend/internal/protocol/messages_test.go.
 */

// Every member of the IntegrityEventKind DB enum, in enum order. Adding a
// member to the enum without adding it here is a type error.
export const EXHAUSTIVE_KINDS = [
  "TAB_HIDDEN",
  "WINDOW_BLUR",
  "COPY_BLOCKED",
  "PASTE_BLOCKED",
  "CONTEXT_MENU_BLOCKED",
  "DEVTOOLS_SUSPECTED",
  "SHORTCUT_BLOCKED",
] as const satisfies readonly IntegrityEventKind[]

// Best-effort client-reported behavioral signals — see
// hooks/use-integrity-monitor.ts for what triggers each kind. Not proof of
// cheating on their own. Record<IntegrityEventKind, string> makes the
// compiler require exactly the enum members, no more, no less.
export const INTEGRITY_KIND_LABELS: Record<IntegrityEventKind, string> = {
  TAB_HIDDEN: "Tab gewechselt",
  WINDOW_BLUR: "Fenster verlassen",
  COPY_BLOCKED: "Kopieren blockiert",
  PASTE_BLOCKED: "Einfügen blockiert",
  CONTEXT_MENU_BLOCKED: "Rechtsklick blockiert",
  DEVTOOLS_SUSPECTED: "Entwicklertools vermutet",
  SHORTCUT_BLOCKED: "Tastenkombination blockiert",
}

/** Nested object ws-backend publishes under the `lastIntegrityEvent` key. */
export interface LastIntegrityEvent {
  kind: IntegrityEventKind
  detail: string
  at: string
}

/** One row of the teacher's live monitor table (REST snapshot + WS patches). */
export interface MonitorSession {
  id: string
  student: { id: string; name: string; email: string }
  status: string
  startedAt: string | null
  effectiveEndTime: string | null
  timeExtensionMin: number
  namApplied: boolean
  lastSeenAt: string | null
  answerCount: number
  integrityEventCount: number
  // Set when this session's SEB Browser Exam Key changed or stopped arriving
  // mid-exam. A signal for the invigilator to look at the candidate, never a
  // reason the student was blocked — see lib/seb-guard.ts.
  sebIntegrityFlagged?: boolean
  sebIntegrityReason?: string | null
}

/**
 * The only shape a monitor:update patch may take. The known keys mirror the
 * keys ws-backend publishes (room.go's broadcastMonitorUpdate call sites and
 * main.go's BEK attestation notify); `lastIntegrityEvent` is patch-only and
 * never appears on MonitorSession itself.
 */
export type MonitorSessionPatch = Partial<
  Pick<
    MonitorSession,
    | "integrityEventCount"
    | "lastSeenAt"
    | "status"
    | "effectiveEndTime"
    | "timeExtensionMin"
    | "namApplied"
    | "sebIntegrityFlagged"
    | "sebIntegrityReason"
  >
> & { lastIntegrityEvent?: LastIntegrityEvent }

const MONITOR_PATCH_KEYS_LIST = [
  "integrityEventCount",
  "lastIntegrityEvent",
  "lastSeenAt",
  "status",
  "effectiveEndTime",
  "timeExtensionMin",
  "namApplied",
  "sebIntegrityFlagged",
  "sebIntegrityReason",
] as const satisfies readonly (keyof MonitorSessionPatch)[]

/** Keys the live monitor may merge from a WS patch; anything else is dropped. */
export const MONITOR_PATCH_KEYS: ReadonlySet<string> = new Set(
  MONITOR_PATCH_KEYS_LIST
)

/**
 * Filters a raw WS monitor patch down to the known keys. A typo'd or
 * unknown key (a future key the client hasn't caught up with, or a stale
 * server publishing something new) no-ops instead of poisoning the session
 * state with a field no one renders. `lastIntegrityEvent` is kept whole —
 * patches are shallow-merged, never deep-merged.
 *
 * Guards against a malformed/empty WS payload (`patch` missing or not an
 * object) and drops explicit `undefined` values — both would otherwise
 * either throw on `Object.entries` or overwrite a valid field with
 * `undefined` once spread into the existing session state
 * (`{ ...existing, ...knownPatch }`).
 */
export function mergeKnownPatchKeys(
  patch: Record<string, unknown> | null | undefined
): MonitorSessionPatch {
  if (!patch) return {}
  const known: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (MONITOR_PATCH_KEYS.has(key) && value !== undefined) known[key] = value
  }
  return known as MonitorSessionPatch
}
