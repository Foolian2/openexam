"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"

/** Prominent, copyable access-code display for teachers to project/share with a class. */
export function AccessCodeChip({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      toast.success("Zugangscode kopiert")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Kopieren fehlgeschlagen")
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border bg-muted/50 px-2.5 py-1 font-mono text-sm font-semibold tracking-wider transition-[color,background-color,border-color,transform] duration-[160ms] ease-out hover:bg-muted active:scale-[0.97]",
        className
      )}
      aria-label={`Zugangscode ${code} kopieren`}
    >
      {code}
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </button>
  )
}
