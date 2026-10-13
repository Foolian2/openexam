"use client"

import { useEffect, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import Link from "next/link"

import { resetPassword } from "@/lib/auth-client"
import {
  resetPasswordSchema,
  type ResetPasswordInput,
} from "@/lib/validators/auth"
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

const INVALID_LINK =
  "Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen Link an."

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [error, setError] = useState<string | null>(token ? null : INVALID_LINK)
  const [done, setDone] = useState(false)

  // Drop the token from the address bar (and so from history and from any
  // later Referer) once the page has it in memory.
  useEffect(() => {
    if (token) window.history.replaceState(null, "", "/reset-password")
  }, [token])

  const {
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  })

  async function onSubmit(data: ResetPasswordInput) {
    if (!token) return
    setError(null)
    try {
      const result = await resetPassword({ newPassword: data.password, token })
      if (result.error) {
        setError(
          result.error.code === "INVALID_TOKEN"
            ? INVALID_LINK
            : authErrorMessage(result.error, "Zurücksetzen fehlgeschlagen.")
        )
        return
      }
      setDone(true)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Verbindungsfehler. Bitte versuchen Sie es erneut."
      )
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1 className="contents">Neues Passwort festlegen</h1>
        </CardTitle>
        <CardDescription>
          Nach dem Speichern werden Sie auf allen Geräten abgemeldet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? (
          <Alert>
            <AlertDescription>
              Ihr Passwort wurde geändert. Sie können sich jetzt mit dem neuen
              Passwort anmelden.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {token && (
              <form
                onSubmit={handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
              >
                <FieldGroup>
                  <Field data-invalid={!!errors.password}>
                    <FieldLabel htmlFor="password">Neues Passwort</FieldLabel>
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
                </FieldGroup>
                <Button
                  type="submit"
                  className="w-full"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Wird gespeichert…
                    </>
                  ) : (
                    "Passwort speichern"
                  )}
                </Button>
              </form>
            )}
          </>
        )}
      </CardContent>
      <CardFooter className="flex flex-col gap-2 text-sm text-muted-foreground">
        <Link
          href="/login"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Zur Anmeldung
        </Link>
        {!done && (
          <Link
            href="/forgot-password"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Neuen Link anfordern
          </Link>
        )}
      </CardFooter>
    </Card>
  )
}
