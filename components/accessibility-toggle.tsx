"use client"

import * as React from "react"
import type { LucideIcon } from "lucide-react"

import {
  useAccessibility,
  type AccessibilityPrefKey,
} from "@/components/accessibility-provider"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

function useMounted() {
  return React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

interface AccessibilityToggleProps {
  pref: AccessibilityPrefKey
  variant: "icon" | "switch"
  label: string
  icon?: LucideIcon
}

export function AccessibilityToggle({ pref, variant, label, icon: Icon }: AccessibilityToggleProps) {
  const { prefs, setPref } = useAccessibility()
  const mounted = useMounted()
  const enabled = prefs[pref]

  if (variant === "icon") {
    if (!mounted) {
      return (
        <Button variant="ghost" size="icon" disabled aria-hidden="true">
          {Icon ? <Icon /> : null}
        </Button>
      )
    }

    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setPref(pref, !enabled)}
        aria-pressed={enabled}
        aria-label={enabled ? `${label} deaktivieren` : `${label} aktivieren`}
        className={enabled ? "text-primary" : undefined}
      >
        {Icon ? <Icon /> : null}
      </Button>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={`a11y-${pref}`}>{label}</Label>
      <Switch
        id={`a11y-${pref}`}
        checked={mounted && enabled}
        disabled={!mounted}
        onCheckedChange={(checked) => setPref(pref, checked)}
      />
    </div>
  )
}
