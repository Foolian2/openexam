/**
 * Battery presentation for the in-exam status strip.
 *
 * Exists because SEB's task bar is hidden (see lib/SEB_OUT_OF_SCOPE.md): the
 * clock and battery indicator it used to provide have to come from the page
 * instead, and a student two hours into a paper on an unplugged laptop needs
 * to see the battery somewhere.
 *
 * Thresholds are SEB's own — batteryChargeThresholdLow (0.2) and
 * batteryChargeThresholdCritical (0.1) in lib/seb-default-root-settings.json —
 * so the warning appears at the same charge SEB itself would have warned at.
 */
export const BATTERY_LOW = 0.2
export const BATTERY_CRITICAL = 0.1

export type BatteryTone = "normal" | "low" | "critical"

export interface BatteryStatus {
  /** 0-100, rounded, clamped. */
  percent: number
  charging: boolean
  tone: BatteryTone
}

/**
 * Returns null for an unreadable level, so the caller renders nothing at all.
 * Showing "0%" in red for a reading we never got would be a false alarm during
 * an exam — worse than showing no battery indicator, which is what a client
 * without the Battery Status API (any WKWebView, so all of macOS SEB) gets
 * anyway.
 *
 * A charging device is never "low": the number is falling only in the sense
 * that it hasn't finished rising yet, and colouring it red would train students
 * to ignore the one case that matters.
 */
export function describeBattery(
  level: number,
  charging: boolean
): BatteryStatus | null {
  if (typeof level !== "number" || Number.isNaN(level)) return null
  // Clamped rather than rejected: ±Infinity and out-of-range fractions are
  // still an unambiguous "full" or "empty".
  const clamped = Math.min(1, Math.max(0, level))
  const tone: BatteryTone = charging
    ? "normal"
    : clamped <= BATTERY_CRITICAL
      ? "critical"
      : clamped <= BATTERY_LOW
        ? "low"
        : "normal"
  return { percent: Math.round(clamped * 100), charging, tone }
}
