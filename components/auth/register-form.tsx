"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import Link from "next/link"

import { signUp } from "@/lib/auth-client"
import { registerSchema, type RegisterInput } from "@/lib/validators/auth"
import { MicrosoftSignInButton } from "@/components/auth/microsoft-signin-button"
import {
  PrivacyCheckboxField,
  SsoPrivacyNotice,
} from "@/components/legal/privacy-acknowledgement"
import { CapWidget } from "@/components/auth/cap-widget"
import { OrDivider } from "@/components/auth/or-divider"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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

export function RegisterForm({
  microsoftEnabled = true,
}: {
  microsoftEnabled?: boolean
}) {
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [capToken, setCapToken] = useState<string | null>(null)
  // Cap tokens are single-use — better-auth's captcha plugin consumes it on
  // verify regardless of whether sign-up itself succeeds (e.g. duplicate
  // email). Bumping this remounts <CapWidget> after any failed attempt so
  // it re-solves for a fresh token, instead of silently reusing a dead one
  // on retry (which otherwise surfaces as a confusing captcha error).
  const [capKey, setCapKey] = useState(0)

  const {
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
      acceptPrivacy: false,
    },
  })

  async function onSubmit(data: RegisterInput) {
    setError(null)
    const result = await signUp.email({
      name: data.name,
      email: data.email,
      password: data.password,
      // Not a user column, so the inferred body type doesn't list it; the
      // server hook (lib/auth.ts) requires it. Spread to pass it through.
      ...{ acceptPrivacy: data.acceptPrivacy },
      fetchOptions: { headers: { "x-captcha-response": capToken ?? "" } },
    })
    if (result.error) {
      setError(authErrorMessage(result.error, "Registrierung fehlgeschlagen."))
      setCapToken(null)
      setCapKey((k) => k + 1)
    } else {
      setSuccess(true)
    }
  }

  if (success) {
    // Mirrors requireEmailVerification in lib/auth.ts: verification is only
    // enforced outside development, so the success copy must match.
    const needsVerification = process.env.NODE_ENV !== "development"
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="contents">Konto erstellt</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {needsVerification ? (
            <>
              <p className="text-sm text-muted-foreground">
                Ihr Konto wurde erfolgreich erstellt. Bevor Sie sich anmelden
                können, müssen Sie Ihre E-Mail-Adresse bestätigen.
              </p>
              <p className="text-sm text-muted-foreground">
                Wir haben Ihnen einen Bestätigungslink per E-Mail geschickt. Der
                Link ist 24 Stunden gültig — prüfen Sie auch Ihren Spam-Ordner.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Ihr Konto wurde erfolgreich erstellt. Sie können sich jetzt
              anmelden.
            </p>
          )}
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">Zur Anmeldung</Link>
          </Button>
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="contents">Registrieren</h1>
        </CardTitle>
        <CardDescription>Erstellen Sie ein neues Konto.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {microsoftEnabled && (
          <>
            <MicrosoftSignInButton />
            <SsoPrivacyNotice />
          </>
        )}
        <OrDivider />
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Controller
                name="name"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="name"
                    placeholder="Max Muster"
                    autoComplete="name"
                    aria-invalid={!!errors.name}
                  />
                )}
              />
              <FieldError errors={[errors.name]} />
            </Field>
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
                    autoComplete="new-password"
                    aria-invalid={!!errors.password}
                  />
                )}
              />
              <FieldError errors={[errors.password]} />
            </Field>
            <Field data-invalid={!!errors.confirmPassword}>
              <FieldLabel htmlFor="confirmPassword">
                Passwort bestätigen
              </FieldLabel>
              <Controller
                name="confirmPassword"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    aria-invalid={!!errors.confirmPassword}
                  />
                )}
              />
              <FieldError errors={[errors.confirmPassword]} />
            </Field>
            <PrivacyCheckboxField
              control={control}
              id="acceptPrivacy"
              error={errors.acceptPrivacy}
            />
          </FieldGroup>
          <CapWidget key={capKey} onSolve={setCapToken} />
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Wird registriert…
              </>
            ) : (
              "Registrieren"
            )}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex justify-center text-sm text-muted-foreground">
        Bereits ein Konto?&nbsp;
        <Link
          href="/login"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Anmelden
        </Link>
      </CardFooter>
    </Card>
  )
}
