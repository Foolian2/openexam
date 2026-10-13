"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { Loader2 } from "lucide-react"

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
})

// Monaco is fetched from cdn.jsdelivr.net (see the CSP in next.config.mjs).
// A school firewall or an offline exam LAN that blocks the CDN left the
// editor on its loading spinner forever, so the code question could not be
// answered at all. Past this deadline, or on a load error, fall back to a
// plain textarea bound to the same value.
const MONACO_LOAD_TIMEOUT_MS = 8000

interface CodeInputProps {
  language: string
  value: string
  onChange: (value: string) => void
  ariaLabel: string
}

export function CodeInput({
  language,
  value,
  onChange,
  ariaLabel,
}: CodeInputProps) {
  const [mounted, setMounted] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (mounted) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) setFailed(true)
    }, MONACO_LOAD_TIMEOUT_MS)
    // Same singleton promise the editor itself awaits, so this adds no
    // second download; it only surfaces a rejected load right away.
    import("@monaco-editor/react")
      .then((m) => m.loader.init())
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mounted])

  if (failed && !mounted) {
    return (
      <div className="space-y-1">
        <textarea
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-64 w-full resize-y rounded-md border bg-muted/30 p-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          Vereinfachter Editor: Der Code-Editor konnte nicht geladen werden.
        </p>
      </div>
    )
  }

  return (
    <div className="h-64 overflow-hidden rounded-md border">
      <MonacoEditor
        language={language}
        value={value}
        onMount={() => setMounted(true)}
        loading={
          <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Editor wird geladen…
          </div>
        }
        onChange={(code) => onChange(code ?? "")}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          ariaLabel,
        }}
        theme="vs-dark"
      />
    </div>
  )
}
