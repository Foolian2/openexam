"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import {
  escapeHtmlText,
  looksLikeHtml,
  sanitizeRichText,
} from "@/lib/html-sanitize"
import { highlightKeywordsInElement } from "@/lib/keyword-highlight"

interface RichTextDisplayProps {
  html: string
  keywords?: string[]
  className?: string
}

/**
 * Read-only rendering of a rich-text answer. Always sanitizes before
 * touching innerHTML. Expected keywords are highlighted in place after
 * hydration, so server and client markup stay identical.
 */
export function RichTextDisplay({
  html,
  keywords,
  className,
}: RichTextDisplayProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const safeHtml = looksLikeHtml(html)
    ? sanitizeRichText(html)
    : escapeHtmlText(html)

  useEffect(() => {
    if (containerRef.current) {
      highlightKeywordsInElement(containerRef.current, keywords ?? [])
    }
  }, [safeHtml, keywords])

  return (
    <div
      ref={containerRef}
      className={cn(
        "rich-text-content text-sm leading-relaxed break-words",
        className
      )}
      // safeHtml is never the raw input: it is sanitizeRichText(html) for
      // markup and escapeHtmlText(html) otherwise, a few lines above.
      // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
}
