import { describe, expect, it } from "vitest"
import { SEB_LOCKED_FIELDS, sebSettingsLockViolation } from "@/lib/seb-config"

describe("sebSettingsLockViolation", () => {
  it("allows everything while the Config Key is not yet frozen", () => {
    expect(sebSettingsLockViolation({ sebConfigKey: null }, { sebRequired: false })).toBeNull()
    expect(sebSettingsLockViolation({ sebConfigKey: null }, { allowSpellCheck: true })).toBeNull()
    expect(sebSettingsLockViolation({ sebConfigKey: null }, { title: "x" })).toBeNull()
  })

  it("allows unrelated edits after the key is frozen", () => {
    expect(sebSettingsLockViolation({ sebConfigKey: "frozen" }, { title: "x" })).toBeNull()
    expect(sebSettingsLockViolation({ sebConfigKey: "frozen" }, { timeLimitMin: 30 })).toBeNull()
    expect(sebSettingsLockViolation({ sebConfigKey: "frozen" }, {})).toBeNull()
  })

  it("rejects SEB-relevant fields after the key is frozen", () => {
    expect(sebSettingsLockViolation({ sebConfigKey: "frozen" }, { sebRequired: false })).toBe(
      "sebRequired"
    )
    expect(sebSettingsLockViolation({ sebConfigKey: "frozen" }, { allowSpellCheck: true })).toBe(
      "allowSpellCheck"
    )
    expect(
      sebSettingsLockViolation({ sebConfigKey: "frozen" }, { title: "x", allowSpellCheck: false })
    ).toBe("allowSpellCheck")
  })

  it("locks exactly the fields that feed the settings dict", () => {
    expect(SEB_LOCKED_FIELDS).toEqual(["sebRequired", "allowSpellCheck"])
  })
})
