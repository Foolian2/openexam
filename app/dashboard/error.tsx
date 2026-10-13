"use client"

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"
import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
    Sentry.captureException(error)
  }, [error])

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Etwas ist schiefgelaufen</h2>
        <p className="text-sm text-muted-foreground">
          Die Seite konnte nicht geladen werden. Bitte versuchen Sie es erneut.
        </p>
      </div>
      <Button onClick={() => reset()}>Erneut versuchen</Button>
    </div>
  )
}
