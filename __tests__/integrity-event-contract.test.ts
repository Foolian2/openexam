import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  EXHAUSTIVE_KINDS,
  INTEGRITY_KIND_LABELS,
  MONITOR_PATCH_KEYS,
  mergeKnownPatchKeys,
  type IntegrityEventKind,
} from "@/lib/monitor-patch"

/**
 * Pins the TypeScript side of the integrity-signal contract to the shared
 * fixture. The fixture is also read by the Go side
 * (ws-backend/internal/protocol/messages_test.go), so the DB enum, the TS
 * types/labels, the Go allow-list and the monitor patch keys cannot drift
 * apart without one of the two suites going red.
 */
const fixture = JSON.parse(
  readFileSync(
    join(process.cwd(), "testdata", "integrity-event-vectors.json"),
    "utf8"
  )
) as { kinds: IntegrityEventKind[]; patchKeys: string[] }

describe("integrity event contract fixture", () => {
  it("fixture kinds are exactly the TS-side allow-list", () => {
    // Assignability through the Prisma-derived enum type: if the fixture
    // contained a kind the DB enum does not know, this line would not
    // compile. The runtime set equality then pins exactness (no missing or
    // extra kinds), and EXHAUSTIVE_KINDS' own `satisfies` in
    // lib/monitor-patch.ts fails the build if a DB enum member is added
    // without being listed there.
    const kinds: readonly IntegrityEventKind[] = fixture.kinds
    expect(fixture.kinds).toEqual(expect.arrayContaining([...EXHAUSTIVE_KINDS]))
    expect(new Set(kinds)).toEqual(new Set(EXHAUSTIVE_KINDS))
  })

  it("labels cover exactly the fixture kinds", () => {
    const labelKinds = Object.keys(INTEGRITY_KIND_LABELS).sort()
    expect(labelKinds).toEqual([...fixture.kinds].sort())
  })

  it("MONITOR_PATCH_KEYS equals the fixture patchKeys", () => {
    expect([...MONITOR_PATCH_KEYS].sort()).toEqual(
      [...fixture.patchKeys].sort()
    )
  })

  it("mergeKnownPatchKeys keeps known keys and drops unknown ones", () => {
    const merged = mergeKnownPatchKeys({
      integrityEventCount: 4,
      lastIntegrityEvent: {
        kind: "TAB_HIDDEN",
        detail: "",
        at: "2026-08-13T12:00:00Z",
      },
      lastSeenAt: "2026-08-13T12:00:01Z",
      status: "IN_PROGRESS",
      effectiveEndTime: "2026-08-13T13:00:00Z",
      timeExtensionMin: 5,
      namApplied: true,
      sebIntegrityFlagged: true,
      sebIntegrityReason: "bek_changed",
      // Unknown keys must no-op instead of poisoning the monitor state.
      notAPatchKey: "poison",
      // A MonitorSession field that is not a patch key must not leak in.
      answerCount: 99,
    })

    expect(merged).toEqual({
      integrityEventCount: 4,
      // The nested object is kept whole — patches are shallow-merged.
      lastIntegrityEvent: {
        kind: "TAB_HIDDEN",
        detail: "",
        at: "2026-08-13T12:00:00Z",
      },
      lastSeenAt: "2026-08-13T12:00:01Z",
      status: "IN_PROGRESS",
      effectiveEndTime: "2026-08-13T13:00:00Z",
      timeExtensionMin: 5,
      namApplied: true,
      sebIntegrityFlagged: true,
      sebIntegrityReason: "bek_changed",
    })
    expect(merged).not.toHaveProperty("notAPatchKey")
    expect(merged).not.toHaveProperty("answerCount")
  })

  it("mergeKnownPatchKeys returns an empty patch when nothing is known", () => {
    expect(mergeKnownPatchKeys({ garbage: 1, junk: "x" })).toEqual({})
  })

  it("mergeKnownPatchKeys drops explicit undefined values instead of keeping them", () => {
    // An explicit `undefined` must not survive the merge: spreading it into
    // the existing session state (`{ ...existing, ...knownPatch }`) would
    // overwrite a previously known-good field with undefined.
    const merged = mergeKnownPatchKeys({
      lastSeenAt: undefined,
      status: "IN_PROGRESS",
    })
    expect(merged).toEqual({ status: "IN_PROGRESS" })
    expect(merged).not.toHaveProperty("lastSeenAt")
  })

  it("mergeKnownPatchKeys tolerates a null or undefined patch", () => {
    expect(mergeKnownPatchKeys(null)).toEqual({})
    expect(mergeKnownPatchKeys(undefined)).toEqual({})
  })
})
