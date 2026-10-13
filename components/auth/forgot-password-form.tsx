"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import Link from "next/link"

import { requestPasswordReset } from "@/lib/auth-client"
import {
  forgotPasswordSchema,
  type ForgotPasswordInput,
} from "@/lib/validators/auth"
import { CapWidget } from "@/components/auth/cap-widget"
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

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [capToken, setCapToken] = useState<string | null>(null)
  // Cap tokens are single-use; remount the widget after a failed attempt
  // (same reasoning as components/auth/login-form.tsx).
  const [capKey, setCapKey] = useState(0)

  const {
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  })

  async function onSubmit(data: ForgotPasswordInput) {
    setError(null)
    try {
      const result = await requestPasswordReset({
        email: data.email,
        redirectTo: "/reset-password",
        fetchOptions: { headers: { "x-captcha-response": capToken ?? "" } },
      })
      if (result.error) {
        setError(authErrorMessage(result.error, "Anfrage fehlgeschlagen."))
        setCapToken(null)
        setCapKey((k) => k + 1)
        return
      }
      setSent(true)
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
          <h1 className="contents">Passwort vergessen</h1>
        </CardTitle>
        <CardDescription>
          Geben Sie Ihre E-Mail-Adresse ein. Wir senden Ihnen einen Link zum
          Zurücksetzen Ihres Passworts.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sent ? (
          // Same message whether or not the address exists: the page must not
          // reveal which email addresses have an account.
          <Alert>
            <AlertDescription>
              Falls ein Konto mit dieser E-Mail-Adresse existiert, haben wir
              Ihnen einen Link gesendet. Er ist 30 Minuten gültig.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <form
              onSubmit={handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
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
              </FieldGroup>
              <CapWidget key={capKey} onSolve={setCapToken} />
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Wird gesendet…
                  </>
                ) : (
                  "Link senden"
                )}
              </Button>
            </form>
          </>
        )}
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        <Link
          href="/login"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Zurück zur Anmeldung
        </Link>
      </CardFooter>
    </Card>
  )
}
