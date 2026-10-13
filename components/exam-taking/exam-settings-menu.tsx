"use client"

import { Settings2 } from "lucide-react"
import { useTheme } from "next-themes"

import { useAccessibility } from "@/components/accessibility-provider"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"

export type ExamTextSize = "sm" | "md" | "lg"

const TEXT_SIZES: { value: ExamTextSize; label: string }[] = [
  { value: "sm", label: "Klein" },
  { value: "md", label: "Normal" },
  { value: "lg", label: "Groß" },
]

function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  label,
}: {
  options: { value: T; label: string }[]
  value: T
  onValueChange: (value: T) => void
  label: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex shrink-0 rounded-md bg-muted p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <Button
            key={option.value}
            type="button"
            variant={active ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            aria-pressed={active}
            onClick={() => onValueChange(option.value)}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}

export function ExamSettingsMenu({
  textSize,
  onTextSizeChange,
}: {
  textSize: ExamTextSize
  onTextSizeChange: (size: ExamTextSize) => void
}) {
  const { prefs, setPrefLocal } = useAccessibility()
  const { resolvedTheme, setTheme } = useTheme()

  const isDark = resolvedTheme === "dark"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Einstellungen">
          <Settings2 className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Design</span>
            <SegmentedControl
              label="Theme"
              options={[
                { value: "light", label: "Hell" },
                { value: "dark", label: "Dunkel" },
              ]}
              value={isDark ? "dark" : "light"}
              onValueChange={(theme) => setTheme(theme)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">Schriftgröße</span>
            <SegmentedControl
              label="Schriftgröße"
              options={TEXT_SIZES}
              value={textSize}
              onValueChange={onTextSizeChange}
            />
          </div>
        </div>
        <Separator />
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="exam-settings-dyslexic">OpenDyslexic-Schriftart</Label>
            <Switch
              id="exam-settings-dyslexic"
              checked={prefs.dyslexicFont}
              onCheckedChange={(checked) => setPrefLocal("dyslexicFont", checked)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="exam-settings-contrast">Hoher Kontrast</Label>
            <Switch
              id="exam-settings-contrast"
              checked={prefs.highContrast}
              onCheckedChange={(checked) => setPrefLocal("highContrast", checked)}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="exam-settings-timer">Countdown ausblenden</Label>
            <Switch
              id="exam-settings-timer"
              checked={prefs.hideExamTimer}
              onCheckedChange={(checked) => setPrefLocal("hideExamTimer", checked)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Diese Einstellungen gelten nur für die aktuelle Prüfung.
        </p>
      </PopoverContent>
    </Popover>
  )
}
