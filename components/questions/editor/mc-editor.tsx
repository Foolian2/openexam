"use client"

import { Plus, Trash2 } from "lucide-react"
import { nanoid } from "nanoid"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { MCConfig } from "@/lib/types/questions"

interface MCEditorProps {
  config: MCConfig
  onChange: (config: MCConfig) => void
}

export function MCEditor({ config, onChange }: MCEditorProps) {
  function setMultiSelect(multiSelect: boolean) {
    const updated = { ...config, multiSelect }
    if (!multiSelect) {
      const firstCorrect = config.options.find((o) => o.isCorrect)?.id ?? null
      updated.options = config.options.map((o) => ({
        ...o,
        isCorrect: o.id === firstCorrect,
      }))
    }
    onChange(updated)
  }

  function addOption() {
    if (config.options.length >= 10) return
    onChange({
      ...config,
      options: [
        ...config.options,
        { id: nanoid(), text: "", isCorrect: false },
      ],
    })
  }

  function removeOption(id: string) {
    if (config.options.length <= 2) return
    onChange({ ...config, options: config.options.filter((o) => o.id !== id) })
  }

  function updateOptionText(id: string, text: string) {
    onChange({
      ...config,
      options: config.options.map((o) => (o.id === id ? { ...o, text } : o)),
    })
  }

  function setCorrect(id: string, checked: boolean) {
    if (config.multiSelect) {
      onChange({
        ...config,
        options: config.options.map((o) =>
          o.id === id ? { ...o, isCorrect: checked } : o
        ),
      })
    } else {
      onChange({
        ...config,
        options: config.options.map((o) => ({ ...o, isCorrect: o.id === id })),
      })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label htmlFor="multiSelect" className="font-normal">
          Mehrfachauswahl erlauben
        </Label>
        <Switch
          id="multiSelect"
          checked={config.multiSelect}
          onCheckedChange={setMultiSelect}
        />
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Optionen</Label>
        {config.multiSelect ? (
          <div className="space-y-2">
            {config.options.map((option) => (
              <div key={option.id} className="flex items-center gap-2">
                <Checkbox
                  checked={option.isCorrect}
                  onCheckedChange={(checked) =>
                    setCorrect(option.id, !!checked)
                  }
                  title="Korrekte Antwort"
                />
                <Input
                  value={option.text}
                  onChange={(e) => updateOptionText(option.id, e.target.value)}
                  placeholder={`Option ${config.options.indexOf(option) + 1}`}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => removeOption(option.id)}
                  disabled={config.options.length <= 2}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <RadioGroup
            value={config.options.find((o) => o.isCorrect)?.id ?? ""}
            onValueChange={(id) => setCorrect(id, true)}
          >
            {config.options.map((option) => (
              <div key={option.id} className="flex items-center gap-2">
                <RadioGroupItem
                  value={option.id}
                  id={`radio-${option.id}`}
                  title="Korrekte Antwort"
                />
                <Input
                  value={option.text}
                  onChange={(e) => updateOptionText(option.id, e.target.value)}
                  placeholder={`Option ${config.options.indexOf(option) + 1}`}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => removeOption(option.id)}
                  disabled={config.options.length <= 2}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </RadioGroup>
        )}

        {config.options.length < 10 && (
          <Button
            variant="outline"
            size="sm"
            onClick={addOption}
            className="mt-1"
          >
            <Plus />
            Option hinzufügen
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {config.multiSelect ? "Checkbox" : "Kreis"} = korrekte Antwort
          markieren
        </p>
      </div>
    </div>
  )
}
