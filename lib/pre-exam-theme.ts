// Session-only theme pin shared between the exam runner (writes the
// pre-exam theme on mount) and components/session-theme-restore.tsx (consumes
// it on the first non-exam page). The key strings must stay identical in all
// places, so they live here instead of being duplicated.
export const PRE_EXAM_THEME_KEY = "openexam:pre-exam-theme-backup"

// In-exam text size survives reloads the same way the theme pin does: the
// runner persists its choice here, and the restore component clears it along
// with the theme pin once the exam is over.
export const EXAM_TEXT_SIZE_KEY = "openexam:pre-exam-text-size"

// Matches /exam/<id>/take — the one page that must keep the in-exam theme
// choice (including across mid-exam reloads) instead of restoring the pin.
export const EXAM_TAKE_PATH_RE = /^\/exam\/[^/]+\/take$/

// The pin is tab-owned: the runner refreshes it while the exam is open, and
// the restore component only consumes pins whose owning tab is gone (stale)
// or that it owns itself. Without this, a second tab opening the dashboard
// mid-exam would consume the pin and leave the exam tab stuck with its
// in-exam theme after submitting.
const PIN_HEARTBEAT_MS = 10_000
const PIN_STALE_MS = 15_000
import {
  readLocal,
  readSession,
  removeLocal,
  writeLocal,
  writeSession,
} from "@/lib/safe-storage"

// sessionStorage: identifies the tab that owns the theme pin.
export const TAB_ID_KEY = "openexam:tab-id"

interface ThemePin {
  theme: string
  tabId: string
  at: number
}

function getTabId(): string | null {
  let id = readSession(TAB_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    // Without a durable tab id the pin cannot record an owner, so report no
    // tab rather than a fresh id every call — callers treat null as "not the
    // owning tab" and leave another tab's pin alone.
    if (!writeSession(TAB_ID_KEY, id)) return null
  }
  return id
}

function parsePin(raw: string | null): ThemePin | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ThemePin>
    if (
      typeof parsed.theme === "string" &&
      typeof parsed.tabId === "string" &&
      typeof parsed.at === "number"
    ) {
      return parsed as ThemePin
    }
  } catch {
    // Legacy pin format (a plain theme string) falls through to null.
  }
  return null
}

/** Called by the exam runner on mount: pins the pre-exam theme once. */
export function writePreExamThemePin(theme: string): void {
  if (readLocal(PRE_EXAM_THEME_KEY) !== null) return
  const tabId = getTabId()
  writeLocal(
    PRE_EXAM_THEME_KEY,
    JSON.stringify({ theme, tabId, at: Date.now() })
  )
}

/**
 * Called by the exam runner on a heartbeat while the exam runs. Only the
 * pin's owning tab refreshes it — a second (reload) heartbeat must not make
 * another exam tab's pin look freshly owned by this one.
 */
export function refreshPreExamThemePin(): void {
  const raw = readLocal(PRE_EXAM_THEME_KEY)
  const pin = parsePin(raw)
  const tabId = getTabId()
  if (!pin || !tabId || pin.tabId !== tabId) return
  writeLocal(PRE_EXAM_THEME_KEY, JSON.stringify({ ...pin, at: Date.now() }))
}

/**
 * Called by the restore component on non-exam pages. Returns the theme to
 * restore, or null when a live exam tab still owns the pin. Consumes the pin
 * (and the in-exam text size) when it does return a theme.
 */
export function takePreExamTheme(): string | null {
  const raw = readLocal(PRE_EXAM_THEME_KEY)
  if (raw === null) return null
  const pin = parsePin(raw)
  if (pin) {
    const tabId = getTabId()
    const ownedByThisTab = tabId !== null && pin.tabId === tabId
    const stale = Date.now() - pin.at > PIN_STALE_MS
    if (!ownedByThisTab && !stale) return null
    removeLocal(PRE_EXAM_THEME_KEY)
    removeLocal(EXAM_TEXT_SIZE_KEY)
    return pin.theme
  }
  // Legacy plain-string pin: consumable unconditionally.
  removeLocal(PRE_EXAM_THEME_KEY)
  removeLocal(EXAM_TEXT_SIZE_KEY)
  return raw
}

export function readExamTextSize(): "sm" | "md" | "lg" | null {
  const stored = readLocal(EXAM_TEXT_SIZE_KEY)
  return stored === "sm" || stored === "lg" ? stored : null
}

export function writeExamTextSize(size: "sm" | "md" | "lg"): void {
  writeLocal(EXAM_TEXT_SIZE_KEY, size)
}

// Re-exported so the heartbeat interval lives next to the staleness window.
export const PRE_EXAM_THEME_HEARTBEAT_MS = PIN_HEARTBEAT_MS
