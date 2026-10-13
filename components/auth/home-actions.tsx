"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { useSession } from "@/lib/auth-client"

/**
 * The only session-dependent part of the landing page. Resolved client-side
 * so `/` itself stays prerendered: reading the session on the server made
 * every hit on the most-visited public route a dynamic render plus a session
 * lookup, just to pick between these two button sets.
 */
export function HomeActions() {
  const { data: session, isPending } = useSession()

  // Reserve the space while the session loads so neither variant flashes
  // (a logged-in user briefly seeing "Anmelden" reads as being logged out).
  if (isPending) return <div className="h-16" aria-busy="true" />

  if (session) {
    return (
      <div className="flex flex-col items-center gap-3">
        <p className="text-sm text-muted-foreground">
          Willkommen zurück, {session.user.name}.
        </p>
        <Button asChild>
          <Link href="/dashboard">Zum Dashboard</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <Button asChild>
        <Link href="/login">Anmelden</Link>
      </Button>
      <Button asChild variant="outline">
        <Link href="/register">Registrieren</Link>
      </Button>
    </div>
  )
}
