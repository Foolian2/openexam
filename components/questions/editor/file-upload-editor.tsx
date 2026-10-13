"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { HelpTip } from "@/components/help-tip"
import type { FileUploadConfig } from "@/lib/types/questions"
import { effectiveMaxFileSizeMB, MAX_UPLOAD_MB } from "@/lib/upload-budget"

const COMMON_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".pptx", ".jpg", ".png", ".zip", ".txt", ".py", ".js"]

interface FileUploadEditorProps {
  config: FileUploadConfig
  onChange: (config: FileUploadConfig) => void
}

export function FileUploadEditor({ config, onChange }: FileUploadEditorProps) {
  const [customExt, setCustomExt] = useState("")

  function toggleExtension(ext: string) {
    const current = config.allowedExtensions
    const updated = current.includes(ext) ? current.filter((e) => e !== ext) : [...current, ext]
    onChange({ ...config, allowedExtensions: updated })
  }

  function addCustomExtension(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return
    e.preventDefault()
    let ext = customExt.trim().toLowerCase()
    if (!ext) return
    if (!ext.startsWith(".")) ext = "." + ext
    if (!config.allowedExtensions.includes(ext)) {
      onChange({ ...config, allowedExtensions: [...config.allowedExtensions, ext] })
    }
    setCustomExt("")
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="flex items-center gap-1.5">
          <Label>Erlaubte Dateiformate</Label>
          <HelpTip content="Nur Dateien mit diesen Endungen können hochgeladen werden. Wählen Sie die Formate, in denen Sie die Lösungen erwarten, z.B. .pdf für Dokumente." />
        </span>
        <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
          {COMMON_EXTENSIONS.map((ext) => (
            <label key={ext} className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox
                checked={config.allowedExtensions.includes(ext)}
                onCheckedChange={() => toggleExtension(ext)}
              />
              <span className="text-xs font-mono">{ext}</span>
            </label>
          ))}
        </div>
        <Input
          value={customExt}
          onChange={(e) => setCustomExt(e.target.value)}
          onKeyDown={addCustomExtension}
          placeholder="Weitere Erweiterung (Enter)"
          className="mt-2"
        />
        {config.allowedExtensions.some((ext) => !COMMON_EXTENSIONS.includes(ext)) && (
          <p className="text-xs text-muted-foreground mt-1">
            Benutzerdefiniert: {config.allowedExtensions.filter((e) => !COMMON_EXTENSIONS.includes(e)).join(", ")}
          </p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <Label>Maximale Dateigrösse</Label>
          <span className="text-sm font-medium">{effectiveMaxFileSizeMB(config)} MB</span>
        </div>
        <Slider
          min={1}
          max={MAX_UPLOAD_MB}
          step={1}
          value={[effectiveMaxFileSizeMB(config)]}
          onValueChange={([v]) => onChange({ ...config, maxFileSizeMB: v })}
        />
      </div>

      <div>
        <Label htmlFor="instructions">Anweisungen für Schüler:innen</Label>
        <Textarea
          id="instructions"
          value={config.instructions}
          onChange={(e) => onChange({ ...config, instructions: e.target.value })}
          placeholder="z.B. Laden Sie Ihre Lösung als PDF hoch..."
          rows={3}
          className="mt-1"
        />
      </div>
    </div>
  )
}
