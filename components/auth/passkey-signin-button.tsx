"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { KeyRound } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { authErrorMessage } from "@/lib/auth-error-message"

export function PasskeySignInButton({
  redirectTo = null,
}: {
  /** Same-origin path to land on after sign-in; see lib/safe-redirect.ts. */
  redirectTo?: string | null
} = {}) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setError(null)
    setIsLoading(true)
    try {
      const result = await authClient.signIn.passkey()
      if (result?.error) {
        setError(
          authErrorMessage(
            result.error,
            "Anmeldung mit Passkey fehlgeschlagen."
          )
        )
      } else if (result?.data) {
        router.push(redirectTo ?? "/dashboard")
      } else {
        setError("Anmeldung mit Passkey fehlgeschlagen.")
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Anmeldung mit Passkey fehlgeschlagen."
      )
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full gap-2"
        onClick={handleClick}
        disabled={isLoading}
      >
        <KeyRound className="h-4 w-4" />
        {isLoading ? "Wird angemeldet…" : "Mit Passkey anmelden"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
