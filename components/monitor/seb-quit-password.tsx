"use client"

import { useState } from "react"
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * The exam's SEB emergency-override password. Hidden until the teacher asks for
 * it — the live monitor is routinely on a projector in front of the class, and
 * this password lets anyone who reads it quit Safe Exam Browser.
 *
 * The plaintext never reaches this component's initial props (the server page
 * only tells it whether a password exists) — it's fetched from
 * /api/exams/[id]/seb-quit-password on first reveal and cached in state, so a
 * repeated toggle doesn't re-fetch or re-audit-log.
 */
export function SebQuitPassword({ examId }: { examId: string }) {
  const [password, setPassword] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)

  async function reveal() {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (password !== null) {
      setRevealed(true)
      return
    }
    setLoading(true)
    setError(false)
    try {
      const res = await fetch(`/api/exams/${examId}/seb-quit-password`)
      if (!res.ok) throw new Error("failed")
      const data = await res.json()
      setPassword(data.password)
      setRevealed(true)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  async function copy() {
    if (password === null) return
    await navigator.clipboard.writeText(password)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          SEB-Notfall-Passwort
        </CardTitle>
        <CardDescription>
          Nur für den Notfall: Damit lässt sich Safe Exam Browser beenden, ohne
          die Prüfung abzugeben — etwa wenn ein Gerät hängen bleibt. Schüler:in
          beendet SEB regulär über die Schaltfläche auf der Abschlussseite.
          Nicht auf dem Beamer zeigen.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-sm tracking-widest">
          {error
            ? "Fehler beim Laden"
            : revealed && password !== null
              ? password
              : "••••••••••"}
        </code>
        <Button
          variant="outline"
          size="icon"
          onClick={reveal}
          disabled={loading}
          aria-label={revealed ? "Passwort verbergen" : "Passwort anzeigen"}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : revealed ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={copy}
          disabled={password === null}
          aria-label="Passwort kopieren"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
