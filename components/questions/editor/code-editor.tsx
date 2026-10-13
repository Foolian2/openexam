"use client"

import { Plus, Trash2 } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { HelpTip } from "@/components/help-tip"
import { CodeInput } from "@/components/shared/code-input"
import type { CodeConfig } from "@/lib/types/questions"

interface CodeEditorProps {
  config: CodeConfig
  onChange: (config: CodeConfig) => void
}

export function CodeEditor({ config, onChange }: CodeEditorProps) {
  function addTestCase() {
    onChange({
      ...config,
      testCases: [
        ...config.testCases,
        { input: "", expectedOutput: "", hidden: false, points: 1 },
      ],
    })
  }

  function removeTestCase(index: number) {
    onChange({
      ...config,
      testCases: config.testCases.filter((_, i) => i !== index),
    })
  }

  function updateTestCase(
    index: number,
    field: keyof (typeof config.testCases)[0],
    value: unknown
  ) {
    onChange({
      ...config,
      testCases: config.testCases.map((tc, i) =>
        i === index ? { ...tc, [field]: value } : tc
      ),
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <Label>Programmiersprache</Label>
        <Select
          value={config.language}
          onValueChange={(language) => onChange({ ...config, language })}
        >
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="python">Python</SelectItem>
            <SelectItem value="javascript">JavaScript</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <span className="mb-1 flex items-center gap-1.5">
          <Label>Startcode (optional)</Label>
          <HelpTip content="Code, der den Teilnehmenden als Vorlage angezeigt wird, z.B. ein Funktionsgerüst. Leer lassen, wenn die Teilnehmenden bei null anfangen sollen." />
        </span>
        <CodeInput
          language={config.language}
          value={config.starterCode}
          onChange={(value) => onChange({ ...config, starterCode: value })}
          ariaLabel="Startcode"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Label>Testfälle</Label>
            <HelpTip content="Testfälle werden nicht automatisch ausgeführt: Programmieraufgaben bewertet die Lehrperson. Die Testfälle dienen als Referenz für diese Bewertung und erscheinen mit der erwarteten Ausgabe in der Musterlösung (PDF). Die Punkte pro Testfall sind eine Orientierungshilfe." />
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={addTestCase}
            type="button"
          >
            <Plus />
            Testfall hinzufügen
          </Button>
        </div>

        {config.testCases.length === 0 && (
          <Empty className="border bg-card">
            <EmptyTitle>Keine Testfälle</EmptyTitle>
            <EmptyDescription>
              Fügen Sie über die Schaltfläche oben Testfälle hinzu.
            </EmptyDescription>
          </Empty>
        )}

        <div className="space-y-3">
          {config.testCases.map((tc, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Testfall {i + 1}</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs">
                    <Switch
                      checked={tc.hidden}
                      onCheckedChange={(hidden) =>
                        updateTestCase(i, "hidden", hidden)
                      }
                    />
                    Versteckt
                    <HelpTip content="Versteckte Testfälle erscheinen nur in der Musterlösung, nicht auf dem gedruckten Aufgabenblatt." />
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeTestCase(i)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Eingabe</Label>
                  <Input
                    value={tc.input}
                    onChange={(e) => updateTestCase(i, "input", e.target.value)}
                    placeholder="stdin"
                    className="mt-0.5 font-mono text-xs"
                  />
                </div>
                <div>
                  <Label className="text-xs">Erwartete Ausgabe</Label>
                  <Input
                    value={tc.expectedOutput}
                    onChange={(e) =>
                      updateTestCase(i, "expectedOutput", e.target.value)
                    }
                    placeholder="stdout"
                    className="mt-0.5 font-mono text-xs"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs">Punkte</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={tc.points}
                  onChange={(e) =>
                    updateTestCase(i, "points", parseFloat(e.target.value) || 0)
                  }
                  className="w-20 text-xs"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
