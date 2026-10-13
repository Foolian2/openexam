import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ResendVerificationEmail } from "@/components/auth/resend-verification-email"
import { loginRedirectUrl } from "@/lib/login-redirect"

export const metadata: Metadata = {
  title: "E-Mail bestätigen — OpenExam",
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string
    email?: string
    redirectTo?: string
    sent?: string
  }>
}) {
  const { error, email, redirectTo, sent } = await searchParams

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="contents">E-Mail-Adresse bestätigen</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive">
            Der Bestätigungslink ist ungültig oder abgelaufen. Fordern Sie
            unten einen neuen Link an.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Wir haben Ihnen einen Bestätigungslink gesendet. Bitte prüfen Sie
            Ihre E-Mails und klicken Sie auf den Link. Der Link ist 24 Stunden
            gültig.
          </p>
        )}
        <ResendVerificationEmail
          initialEmail={email}
          redirectTo={redirectTo}
          // `sent=1` is only set by the login form's redirect here, right
          // after better-auth's sendOnSignIn hook fired and started its
          // 5-minute send cooldown server-side. Start the resend button in
          // that state too, or a resend right now would look successful yet
          // silently be dropped by the cooldown (see ResendVerificationEmail).
          cooldownActive={sent === "1"}
        />
        <Button asChild variant="ghost" className="w-full">
          <Link href={redirectTo ? loginRedirectUrl(redirectTo) : "/login"}>
            Zurück zur Anmeldung
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
