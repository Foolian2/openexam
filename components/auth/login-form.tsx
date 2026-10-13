"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import Link from "next/link"

import { signIn } from "@/lib/auth-client"
import { loginSchema, type LoginInput } from "@/lib/validators/auth"
import { MicrosoftSignInButton } from "@/components/auth/microsoft-signin-button"
import { SsoPrivacyNotice } from "@/components/legal/privacy-acknowledgement"
import { CapWidget } from "@/components/auth/cap-widget"
import { PasskeySignInButton } from "@/components/auth/passkey-signin-button"
import { OrDivider } from "@/components/auth/or-divider"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { authErrorMessage } from "@/lib/auth-error-message"

export function LoginForm({
  microsoftEnabled = true,
  redirectTo = null,
}: {
  microsoftEnabled?: boolean
  /**
   * Where to land after a successful sign-in. Already validated as a
   * same-origin path by the page (lib/safe-redirect.ts); null falls back to
   * the dashboard.
   */
  redirectTo?: string | null
}) {
  const router = useRouter()
  const destination = redirectTo ?? "/dashboard"
  const [error, setError] = useState<string | null>(null)
  const [capToken, setCapToken] = useState<string | null>(null)
  // Cap tokens are single-use — better-auth's captcha plugin consumes it on
  // verify regardless of whether the credentials themselves are valid.
  // Bumping this remounts <CapWidget> after any failed attempt so it
  // re-solves for a fresh token, instead of silently reusing a dead one on
  // retry (which otherwise surfaces as a confusing captcha error, not a
  // wrong-password error).
  const [capKey, setCapKey] = useState(0)

  const {
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  async function onSubmit(data: LoginInput) {
    setError(null)
    try {
      const result = await signIn.email({
        email: data.email,
        password: data.password,
        // Also used by better-auth's sendOnSignIn verification email as the
        // link's post-verification target. An unauthenticated visit to
        // `destination` there is caught by proxy.ts's session guard and
        // bounced to /login?next=destination, so the deep link
        // survives instead of dropping to the default dashboard.
        callbackURL: destination,
        fetchOptions: { headers: { "x-captcha-response": capToken ?? "" } },
      })
      if (result.error) {
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          router.push(
            `/verify-email?email=${encodeURIComponent(data.email)}&redirectTo=${encodeURIComponent(destination)}&sent=1`
          )
          return
        }
        setError(authErrorMessage(result.error, "Anmeldung fehlgeschlagen."))
        setCapToken(null)
        setCapKey((k) => k + 1)
      } else {
        router.push(destination)
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Verbindungsfehler. Bitte versuchen Sie es erneut."
      )
      setCapToken(null)
      setCapKey((k) => k + 1)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="contents">Anmelden</h1>
        </CardTitle>
        <CardDescription>
          Melden Sie sich mit Ihrer E-Mail-Adresse an.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {microsoftEnabled && (
          <>
            <MicrosoftSignInButton redirectTo={redirectTo} />
            {/* First-time Microsoft users get their account created straight
                from this button, and lib/auth.ts records the acknowledgement
                on that path — so the notice has to be here too, not only on
                the registration pages. */}
            <SsoPrivacyNotice />
          </>
        )}
        <PasskeySignInButton redirectTo={redirectTo} />
        <OrDivider />
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="email">E-Mail-Adresse</FieldLabel>
              <Controller
                name="email"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="email"
                    type="email"
                    placeholder="max.muster@schule.ch"
                    autoComplete="email"
                    aria-invalid={!!errors.email}
                  />
                )}
              />
              <FieldError errors={[errors.email]} />
            </Field>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="password">Passwort</FieldLabel>
              <Controller
                name="password"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    aria-invalid={!!errors.password}
                  />
                )}
              />
              <FieldError errors={[errors.password]} />
              <Link
                href="/forgot-password"
                className="self-end text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Passwort vergessen?
              </Link>
            </Field>
          </FieldGroup>
          <CapWidget key={capKey} onSolve={setCapToken} />
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Wird angemeldet…
              </>
            ) : (
              "Anmelden"
            )}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col gap-2 text-sm text-muted-foreground">
        <span>
          Noch kein Konto?&nbsp;
          <Link
            href="/register"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Registrieren
          </Link>
        </span>
        <span>
          Lehrperson?&nbsp;
          <Link
            href="/register-teacher"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Lehrerkonto erstellen
          </Link>
        </span>
      </CardFooter>
    </Card>
  )
}
