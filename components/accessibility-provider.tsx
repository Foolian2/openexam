"use client"

import * as React from "react"
import { use } from "react"
import { toast } from "sonner"

import { authClient } from "@/lib/auth-client"

export interface AccessibilityPrefs {
  dyslexicFont: boolean
  highContrast: boolean
  reducedMotion: boolean
  hideExamTimer: boolean
}

export type AccessibilityPrefKey = keyof AccessibilityPrefs

interface AccessibilityContextValue {
  prefs: AccessibilityPrefs
  setPref: (key: AccessibilityPrefKey, value: boolean) => Promise<void>
  // Session-only variant: applies the pref locally (classes on <html> etc.)
  // without persisting to the user row. Used by the exam runner's temporary
  // settings menu; dies with the provider's state when the page unmounts.
  setPrefLocal: (key: AccessibilityPrefKey, value: boolean) => void
}

const AccessibilityContext = React.createContext<AccessibilityContextValue | null>(null)

const PREF_CLASSES: Partial<Record<AccessibilityPrefKey, string>> = {
  dyslexicFont: "dyslexic",
  highContrast: "high-contrast",
  reducedMotion: "reduce-motion",
}

const ALL_PREFS: AccessibilityPrefKey[] = [
  "dyslexicFont",
  "highContrast",
  "reducedMotion",
  "hideExamTimer",
]

const DEFAULT_PREFS: AccessibilityPrefs = {
  dyslexicFont: false,
  highContrast: false,
  reducedMotion: false,
  hideExamTimer: false,
}

// The initial values come from the server session (passed by the layouts that
// already hold it), so this provider never runs a client-side session fetch —
// that kept the whole better-auth + passkey client in the initial bundle of
// every page, including the public login/register pages.
function AccessibilityProvider({
  children,
  initialPrefs = {},
}: {
  children: React.ReactNode
  initialPrefs?: Partial<AccessibilityPrefs>
}) {
  // Last server-confirmed value per key. Rollback on a failed update is
  // per-key against this, so concurrent toggles of different prefs can't
  // resurrect a stale optimistic value for an unrelated key.
  const confirmed = React.useRef<AccessibilityPrefs>({ ...DEFAULT_PREFS, ...initialPrefs })
  const [prefs, setPrefs] = React.useState<AccessibilityPrefs>(() => ({
    ...DEFAULT_PREFS,
    ...initialPrefs,
  }))

  React.useEffect(() => {
    const root = document.documentElement
    for (const key of ALL_PREFS) {
      const className = PREF_CLASSES[key]
      if (className) root.classList.toggle(className, prefs[key])
    }
  }, [prefs])

  const setPref = React.useCallback(async (key: AccessibilityPrefKey, value: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: value }))

    try {
      const { error } = await authClient.updateUser({ [key]: value })
      if (error) {
        setPrefs((prev) => ({ ...prev, [key]: confirmed.current[key] }))
        toast.error(error.message ?? "Fehler beim Speichern.")
      } else {
        confirmed.current[key] = value
      }
    } catch (e) {
      setPrefs((prev) => ({ ...prev, [key]: confirmed.current[key] }))
      toast.error(
        e instanceof Error ? e.message : "Verbindungsfehler. Bitte versuchen Sie es erneut."
      )
    }
  }, [])

  const setPrefLocal = React.useCallback((key: AccessibilityPrefKey, value: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: value }))
  }, [])

  const value = React.useMemo(
    () => ({ prefs, setPref, setPrefLocal }),
    [prefs, setPref, setPrefLocal]
  )

  return <AccessibilityContext.Provider value={value}>{children}</AccessibilityContext.Provider>
}

function useAccessibility() {
  const context = use(AccessibilityContext)
  if (!context) {
    throw new Error("useAccessibility must be used within an AccessibilityProvider")
  }
  return context
}

function useDyslexicFont() {
  const { prefs, setPref } = useAccessibility()
  return {
    enabled: prefs.dyslexicFont,
    setEnabled: (value: boolean) => setPref("dyslexicFont", value),
  }
}

export { AccessibilityProvider, useAccessibility, useDyslexicFont }
