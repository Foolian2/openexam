import type { Metadata } from "next"
import { ResetPasswordForm } from "@/components/auth/reset-password-form"

export const metadata: Metadata = {
  title: "Passwort zurücksetzen — OpenExam",
  // The URL carries a live reset token; nginx logs the Referer header, so
  // this page's own asset and API requests must not send it.
  referrer: "no-referrer",
}

/**
 * Landing page of the reset email link (/reset-password?token=…, built in
 * lib/auth.ts sendResetPassword). An invalid or expired token is reported
 * when the form is submitted. ?error= is still honoured for better-auth's own
 * /api/auth/reset-password/:token redirect.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>
}) {
  const { token, error } = await searchParams
  return <ResetPasswordForm token={!error && token ? token : null} />
}
