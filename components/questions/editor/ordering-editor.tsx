"use client"

import { nanoid } from "nanoid"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Plus, Trash2, Info } from "lucide-react"
import type { OrderingConfig } from "@/lib/types/questions"

interface OrderingEditorProps {
  config: OrderingConfig
  onChange: (config: OrderingConfig) => void
}

export function OrderingEditor({ config, onChange }: OrderingEditorProps) {
  function addItem() {
    if (config.items.length >= 20) return
    onChange({
      ...config,
      items: [...config.items, { id: nanoid(), text: "" }],
    })
  }

  function removeItem(id: string) {
    if (config.items.length <= 2) return
    onChange({ ...config, items: config.items.filter((i) => i.id !== id) })
  }

  function updateText(id: string, text: string) {
    onChange({
      ...config,
      items: config.items.map((i) => (i.id === id ? { ...i, text } : i)),
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-snug text-muted-foreground">
          Geben Sie die Elemente in der{" "}
          <span className="font-medium">korrekten Reihenfolge</span> ein. Die
          Studierenden erhalten die Elemente in zufälliger Reihenfolge und
          müssen sie neu anordnen.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">
          Elemente (in korrekter Reihenfolge)
        </Label>
        {config.items.map((item, idx) => (
          <div key={item.id} className="flex items-center gap-2">
            <span className="w-5 text-right text-xs text-muted-foreground tabular-nums">
              {idx + 1}.
            </span>
            <Input
              value={item.text}
              onChange={(e) => updateText(item.id, e.target.value)}
              placeholder={`Element ${idx + 1}`}
              className="flex-1"
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => removeItem(item.id)}
              disabled={config.items.length <= 2}
              type="button"
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        {config.items.length < 20 && (
          <Button
            variant="outline"
            size="sm"
            onClick={addItem}
            type="button"
            className="mt-1"
          >
            <Plus />
            Element hinzufügen
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="order-shuffle" className="font-normal">
          Server-seitig mischen (pro Sitzung neu)
        </Label>
        <Switch
          id="order-shuffle"
          checked={config.shuffle}
          onCheckedChange={(shuffle) => onChange({ ...config, shuffle })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Wenn deaktiviert, werden die Elemente in umgekehrter Reihenfolge
        angezeigt (fest, aber nicht die Lösungsreihenfolge).
      </p>
    </div>
  )
}
