"use client"

import { nanoid } from "nanoid"
import { Plus, Trash2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { HelpTip } from "@/components/help-tip"
import type { MatchingConfig } from "@/lib/types/questions"

interface MatchingEditorProps {
  config: MatchingConfig
  onChange: (config: MatchingConfig) => void
}

export function MatchingEditor({ config, onChange }: MatchingEditorProps) {
  function addPair() {
    if (config.pairs.length >= 10) return
    onChange({
      ...config,
      pairs: [...config.pairs, { id: nanoid(), left: "", right: "" }],
    })
  }

  function removePair(id: string) {
    if (config.pairs.length <= 3) return
    onChange({ ...config, pairs: config.pairs.filter((p) => p.id !== id) })
  }

  function updatePair(id: string, side: "left" | "right", value: string) {
    onChange({
      ...config,
      pairs: config.pairs.map((p) =>
        p.id === id ? { ...p, [side]: value } : p
      ),
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <Label htmlFor="shuffleSides" className="font-normal">
            Seiten zufällig anordnen
          </Label>
          <HelpTip content="Wenn aktiviert, werden die rechten Einträge (Definitionen) für jede Person gemischt, damit nicht alle dieselbe Reihenfolge sehen." />
        </span>
        <Switch
          id="shuffleSides"
          checked={config.shuffleSides}
          onCheckedChange={(shuffleSides) =>
            onChange({ ...config, shuffleSides })
          }
        />
      </div>

      <div>
        <div className="mb-1 grid grid-cols-2 gap-2">
          <Label className="text-center text-xs text-muted-foreground">
            Begriff (links)
          </Label>
          <Label className="text-center text-xs text-muted-foreground">
            Definition (rechts)
          </Label>
        </div>
        <div className="space-y-2">
          {config.pairs.map((pair, i) => (
            <div key={pair.id} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">
                {i + 1}.
              </span>
              <Input
                value={pair.left}
                onChange={(e) => updatePair(pair.id, "left", e.target.value)}
                placeholder="Begriff"
                className="flex-1"
              />
              <span className="shrink-0 text-muted-foreground">↔</span>
              <Input
                value={pair.right}
                onChange={(e) => updatePair(pair.id, "right", e.target.value)}
                placeholder="Definition"
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => removePair(pair.id)}
                disabled={config.pairs.length <= 3}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>

        {config.pairs.length < 10 && (
          <Button
            variant="outline"
            size="sm"
            onClick={addPair}
            className="mt-2"
          >
            <Plus />
            Paar hinzufügen
          </Button>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          3–10 Paare erforderlich
        </p>
      </div>
    </div>
  )
}
