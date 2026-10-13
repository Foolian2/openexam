"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { loginRedirectUrl } from "@/lib/login-redirect"

/**
 * Client-side replacement for `redirect("/login")` in server layouts: carries
 * the current path (incl. query string) as `redirectTo` so the user lands
 * back where they wanted after logging in. Server components can't read
 * their own URL, hence client.
 */
export function LoginRedirect() {
  const router = useRouter()

  useEffect(() => {
    const target = window.location.pathname + window.location.search
    router.replace(loginRedirectUrl(target))
  }, [router])

  return null
}
