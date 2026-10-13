"use client"

import { SpellCheck } from "lucide-react"

import { AccessibilityToggle } from "@/components/accessibility-toggle"

interface DyslexicFontToggleProps {
  variant: "icon" | "switch"
  label?: string
}

export function DyslexicFontToggle({ variant, label }: DyslexicFontToggleProps) {
  return (
    <AccessibilityToggle
      pref="dyslexicFont"
      variant={variant}
      label={label ?? "OpenDyslexic-Schriftart"}
      icon={SpellCheck}
    />
  )
}
