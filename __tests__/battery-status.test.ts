import { describe, expect, it } from "vitest"
import {
  BATTERY_CRITICAL,
  BATTERY_LOW,
  describeBattery,
} from "@/lib/battery-status"

describe("describeBattery", () => {
  it("keeps SEB's own thresholds, so the warning appears where SEB's would have", () => {
    // lib/seb-default-root-settings.json: batteryChargeThresholdLow /
    // batteryChargeThresholdCritical.
    expect(BATTERY_LOW).toBe(0.2)
    expect(BATTERY_CRITICAL).toBe(0.1)
  })

  it("reports a rounded percentage", () => {
    expect(describeBattery(0.874, false)?.percent).toBe(87)
    expect(describeBattery(1, true)?.percent).toBe(100)
    expect(describeBattery(0, false)?.percent).toBe(0)
  })

  it("escalates on the way down, boundaries included", () => {
    expect(describeBattery(0.5, false)?.tone).toBe("normal")
    expect(describeBattery(0.21, false)?.tone).toBe("normal")
    expect(describeBattery(BATTERY_LOW, false)?.tone).toBe("low")
    expect(describeBattery(0.11, false)?.tone).toBe("low")
    expect(describeBattery(BATTERY_CRITICAL, false)?.tone).toBe("critical")
    expect(describeBattery(0.02, false)?.tone).toBe("critical")
  })

  it("never warns while charging — the number is rising, not falling", () => {
    expect(describeBattery(0.05, true)?.tone).toBe("normal")
    expect(describeBattery(0.05, true)?.charging).toBe(true)
  })

  it("clamps values outside 0..1 instead of rendering 140%", () => {
    expect(describeBattery(1.4, false)?.percent).toBe(100)
    expect(describeBattery(-0.2, false)?.percent).toBe(0)
    expect(describeBattery(Infinity, false)?.percent).toBe(100)
  })

  it("returns null for an unreadable level rather than a red 0%", () => {
    // A false low-battery alarm mid-exam is worse than no indicator at all.
    expect(describeBattery(NaN, false)).toBeNull()
    expect(describeBattery(undefined as unknown as number, false)).toBeNull()
  })
})
