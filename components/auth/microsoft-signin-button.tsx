"use client"

import { useState } from "react"
import { signIn } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"
import { authErrorMessage } from "@/lib/auth-error-message"

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="h-4 w-4" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  )
}

export function MicrosoftSignInButton({
  redirectTo = null,
}: {
  /** Same-origin path to land on after sign-in; see lib/safe-redirect.ts. */
  redirectTo?: string | null
} = {}) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setError(null)
    setIsLoading(true)
    // signIn.social, not the removed signIn.oauth2: better-auth 1.7 runs
    // generic OAuth providers through the built-in social-provider path,
    // where the generic `providerId` is passed as `provider`.
    const result = await signIn.social({
      provider: "microsoft-entra-id",
      callbackURL: redirectTo ?? "/dashboard",
    })
    if (result.error) {
      setError(
        authErrorMessage(
          result.error,
          "Anmeldung mit Microsoft fehlgeschlagen."
        )
      )
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
        <MicrosoftLogo />
        {isLoading ? "Wird weitergeleitet…" : "Mit Microsoft anmelden"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
