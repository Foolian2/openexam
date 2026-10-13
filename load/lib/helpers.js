// Shared utility functions for k6 scenarios.
// Each scenario currently imports duration functions independently;
// having them here avoids duplication and keeps both in sync.

/**
 * Parses a k6-style duration string ("10s", "2m", "3.5h") to milliseconds.
 * Supports decimal values (e.g. "1.5m" = 90000ms) and ms/s/m/h suffixes.
 */
export function durationToMs(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
  if (!match)
    throw new Error(
      `Unparseable duration "${value}" — expected a number followed by ms, s, m, or h.`
    )
  const n = Number(match[1])
  const unitMs = { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]]
  return n * unitMs
}
