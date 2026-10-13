"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { authClient } from "@/lib/auth-client"
import { loginRedirectUrl, safeRedirectTo } from "@/lib/login-redirect"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { authErrorMessage } from "@/lib/auth-error-message"

interface ResendVerificationEmailProps {
  initialEmail?: string
  redirectTo?: string
  /** Start the button in its cooldown state (see the countdown effect below). */
  cooldownActive?: boolean
}

// Mirrors the 5-minute send cooldown enforced server-side in lib/auth.ts's
// sendVerificationEmail hook. Better Auth reports success even when that
// hook silently drops a suppressed send, so the button tracks the same
// window locally and disables itself instead of claiming a resend that
// never happened.
const COOLDOWN_SECONDS = 5 * 60

export function ResendVerificationEmail({
  initialEmail,
  redirectTo,
  cooldownActive = false,
}: ResendVerificationEmailProps) {
  const [email, setEmail] = useState(initialEmail ?? "")
  const [sending, setSending] = useState(false)
  const [cooldownRemaining, setCooldownRemaining] = useState(
    cooldownActive ? COOLDOWN_SECONDS : 0
  )

  useEffect(() => {
    if (cooldownRemaining <= 0) return
    const interval = setInterval(() => {
      setCooldownRemaining((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [cooldownRemaining])

  async function handleResend() {
    const trimmed = email.trim()
    if (!trimmed) return
    setSending(true)
    try {
      const callbackURL = redirectTo
        ? `${window.location.origin}${loginRedirectUrl(safeRedirectTo(redirectTo))}`
        : `${window.location.origin}/login`
      const { error } = await authClient.sendVerificationEmail({
        email: trimmed,
        callbackURL,
      })
      if (error) {
        toast.error(
          authErrorMessage(
            error,
            "Senden fehlgeschlagen. Bitte versuchen Sie es erneut."
          )
        )
        return
      }
      setCooldownRemaining(COOLDOWN_SECONDS)
      toast.success("Bestätigungslink gesendet")
    } catch {
      toast.error("Verbindungsfehler. Bitte versuchen Sie es erneut.")
    } finally {
      setSending(false)
    }
  }

  const onCooldown = cooldownRemaining > 0

  return (
    <div className="space-y-2">
      <Label htmlFor="resend-email">E-Mail-Adresse</Label>
      <Input
        id="resend-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="max.muster@schule.ch"
        autoComplete="email"
      />
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => void handleResend()}
        disabled={sending || onCooldown || !email.trim()}
      >
        {sending
          ? "Wird gesendet…"
          : onCooldown
            ? `Erneut senden in ${Math.ceil(cooldownRemaining / 60)} Min.`
            : "Bestätigungslink erneut senden"}
      </Button>
      {onCooldown && (
        <p className="text-xs text-muted-foreground">
          Aus Sicherheitsgründen kann nur alle 5 Minuten ein neuer Link
          angefordert werden. Prüfen Sie in der Zwischenzeit Ihren Spam-Ordner.
        </p>
      )}
    </div>
  )
}
