"use client"

import { useRef, useState } from "react"
import { Upload, File, Loader2, Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { sebFetch } from "@/lib/seb-client"
import { apiMutate } from "@/lib/api-mutate"
import type { FileUploadConfig } from "@/lib/types/questions"
import type { FileUploadAnswer } from "@/lib/types/answers"
import { effectiveMaxFileSizeMB } from "@/lib/upload-budget"

interface FileUploadViewerProps {
  config: FileUploadConfig
  answer?: FileUploadAnswer
  onChange?: (answer: FileUploadAnswer) => void
  readOnly?: boolean
  sessionId?: string
  questionId?: string
}

export function FileUploadViewer({
  config,
  answer,
  onChange,
  readOnly,
  sessionId,
  questionId,
}: FileUploadViewerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState("")
  const [downloading, setDownloading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const maxMB = effectiveMaxFileSizeMB(config)

  async function handleFile(file: File) {
    setError("")
    const ext = "." + file.name.split(".").pop()?.toLowerCase()
    if (!config.allowedExtensions.includes(ext)) {
      setError(
        `Dateityp nicht erlaubt. Erlaubt: ${config.allowedExtensions.join(", ")}`
      )
      return
    }
    if (file.size > maxMB * 1024 * 1024) {
      setError(`Datei zu gross. Maximum: ${maxMB} MB`)
      return
    }
    if (!sessionId || !questionId) return

    setUploading(true)
    try {
      const body = new FormData()
      body.append("questionId", questionId)
      body.append("file", file)
      const result = await apiMutate<{ fileKey: string; fileName: string }>(
        `/api/sessions/${sessionId}/upload`,
        {
          body,
          fetcher: sebFetch,
          fallbackError: "Upload fehlgeschlagen",
          networkError:
            "Netzwerkfehler beim Hochladen. Bitte erneut versuchen.",
        }
      )
      if (!result.ok) {
        setError(result.message)
        return
      }
      onChange?.({
        fileKey: result.data.fileKey,
        fileName: result.data.fileName,
      })
    } finally {
      setUploading(false)
    }
  }

  async function handleDownload() {
    if (!sessionId || !questionId) return
    setDownloading(true)
    try {
      const res = await sebFetch(
        `/api/sessions/${sessionId}/download?questionId=${questionId}`
      )
      const data = await res.json()
      if (!res.ok) {
        setError(data.error?.message ?? "Datei konnte nicht geladen werden")
        return
      }
      window.open(data.url, "_blank", "noopener,noreferrer")
    } catch {
      setError("Netzwerkfehler beim Herunterladen. Bitte erneut versuchen.")
    } finally {
      setDownloading(false)
    }
  }

  if (readOnly) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        {answer ? (
          <div className="flex items-center gap-2">
            <File className="h-4 w-4" />
            {sessionId && questionId ? (
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-sm"
                onClick={handleDownload}
                disabled={downloading}
              >
                {downloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {answer.fileName}
              </Button>
            ) : (
              answer.fileName
            )}
          </div>
        ) : (
          "Keine Datei hochgeladen"
        )}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {config.instructions && (
        <p className="text-sm text-muted-foreground">{config.instructions}</p>
      )}

      <div
        role="button"
        tabIndex={0}
        aria-label="Datei hochladen"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) void handleFile(file)
        }}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
          dragOver ? "border-primary bg-accent/40" : ""
        }`}
      >
        {uploading ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Wird hochgeladen…
          </div>
        ) : answer ? (
          <div className="flex items-center justify-center gap-2">
            <File className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm">{answer.fileName}</span>
          </div>
        ) : (
          <div className="space-y-1">
            <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Datei hierher ziehen oder klicken
            </p>
            <p className="text-xs text-muted-foreground">
              {config.allowedExtensions.join(", ")} · max.{" "}
              {maxMB} MB
            </p>
          </div>
        )}
      </div>

      {answer && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={downloading}
          >
            {downloading ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1 h-3.5 w-3.5" />
            )}
            Herunterladen
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="mr-1 h-3.5 w-3.5" />
            Ersetzen
          </Button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={config.allowedExtensions.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
          e.target.value = ""
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
