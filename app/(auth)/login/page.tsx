import type { Metadata } from "next"
import { LoginForm } from "@/components/auth/login-form"
import { microsoftConfigured } from "@/lib/env"
import { safeRedirectPath } from "@/lib/safe-redirect"

export const metadata: Metadata = {
  title: "Anmelden — OpenExam",
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  // Validated here rather than in the client component so an off-site value
  // never reaches the browser at all. See lib/safe-redirect.ts.
  const redirectTo = safeRedirectPath(next)

  return (
    <LoginForm microsoftEnabled={microsoftConfigured()} redirectTo={redirectTo} />
  )
}
