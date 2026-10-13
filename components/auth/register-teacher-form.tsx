"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { z } from "zod"

import { apiMutate } from "@/lib/api-mutate"
import { registerSchema } from "@/lib/validators/auth"
import { MicrosoftSignInButton } from "@/components/auth/microsoft-signin-button"
import {
  PrivacyCheckboxField,
  SsoPrivacyNotice,
} from "@/components/legal/privacy-acknowledgement"
import { CapWidget } from "@/components/auth/cap-widget"
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

const schema = registerSchema.and(
  z.object({ accessCode: z.string().min(1, "Zugangscode ist erforderlich") })
)

type FormInput = z.infer<typeof schema>

export function RegisterTeacherForm({
  microsoftEnabled = true,
  teacherDomains = [],
}: {
  microsoftEnabled?: boolean
  teacherDomains?: string[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<{ email: string } | null>(null)
  // Cap tokens are single-use — consumed on verify regardless of outcome.
  // Bumping this remounts the <CapWidget> after a failed attempt so it
  // re-solves for a fresh token, instead of silently reusing a dead one on
  // retry.
  const [signUpCapToken, setSignUpCapToken] = useState<string | null>(null)
  const [signUpCapKey, setSignUpCapKey] = useState(0)

  const {
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<FormInput>({
    resolver: zodResolver(schema) as never,
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
      accessCode: "",
      acceptPrivacy: false,
    },
  })

  async function onSubmit(data: FormInput) {
    setError(null)

    // Registration is one server-side step: captcha verified against Cap,
    // access code checked (constant-time), account created as TEACHER,
    // verification email sent. Production requires email verification, so
    // there is no session here — the success screen below tells the teacher
    // to verify within 24h (see /api/teacher/register and lib/auth.ts).
    const result = await apiMutate("/api/teacher/register", {
      body: {
        name: data.name,
        email: data.email,
        password: data.password,
        accessCode: data.accessCode,
        captchaToken: signUpCapToken ?? "",
        acceptPrivacy: data.acceptPrivacy,
      },
      fallbackError: "Registrierung fehlgeschlagen.",
    })
    if (!result.ok) {
      setError(result.message)
      setSignUpCapToken(null)
      setSignUpCapKey((k) => k + 1)
      return
    }

    setSuccess({ email: data.email })
  }

  if (success) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Konto erstellt</CardTitle>
          <CardDescription>
            Bitte bestätigen Sie Ihre E-Mail-Adresse innerhalb von 24 Stunden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Alert>
            <AlertDescription>
              Wir haben einen Bestätigungslink an{" "}
              <strong>{success.email}</strong> gesendet. Klicken Sie ihn
              innerhalb von 24 Stunden an — danach ist der Link ungültig. Falls
              Sie keine E-Mail erhalten haben, melden Sie sich einfach an: Der
              Link wird dann erneut gesendet.
            </AlertDescription>
          </Alert>
          <Button className="w-full" onClick={() => router.push("/login")}>
            Zur Anmeldung
          </Button>
        </CardContent>
        <CardFooter className="flex flex-col gap-2 text-sm text-muted-foreground">
          <span>
            Bereits ein Konto?{" "}
            <Link
              href="/login"
              className="text-foreground underline-offset-4 hover:underline"
            >
              Anmelden
            </Link>
          </span>
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Lehrperson registrieren</CardTitle>
        <CardDescription>Konto für Lehrpersonen erstellen.</CardDescription>
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
        {microsoftEnabled && teacherDomains.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Mit einem {teacherDomains.map((d) => `@${d}`).join("- oder ")}
            -Konto werden Sie über Microsoft automatisch als Lehrperson erkannt
            — ein Zugangscode ist dann nicht nötig.
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-px flex-1 bg-border" />
          oder
          <div className="h-px flex-1 bg-border" />
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="t-name">Name</FieldLabel>
              <Controller
                name="name"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="t-name"
                    placeholder="Max Muster"
                    autoComplete="name"
                    aria-invalid={!!errors.name}
                  />
                )}
              />
              <FieldError errors={[errors.name]} />
            </Field>

            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="t-email">E-Mail-Adresse</FieldLabel>
              <Controller
                name="email"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="t-email"
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
              <FieldLabel htmlFor="t-password">Passwort</FieldLabel>
              <Controller
                name="password"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="t-password"
                    type="password"
                    autoComplete="new-password"
                    aria-invalid={!!errors.password}
                  />
                )}
              />
              <FieldError errors={[errors.password]} />
            </Field>

            <Field data-invalid={!!errors.confirmPassword}>
              <FieldLabel htmlFor="t-confirm">Passwort bestätigen</FieldLabel>
              <Controller
                name="confirmPassword"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="t-confirm"
                    type="password"
                    autoComplete="new-password"
                    aria-invalid={!!errors.confirmPassword}
                  />
                )}
              />
              <FieldError errors={[errors.confirmPassword]} />
            </Field>

            <Field data-invalid={!!errors.accessCode}>
              <FieldLabel htmlFor="t-code">Lehrerzugangscode</FieldLabel>
              <Controller
                name="accessCode"
                control={control}
                render={({ field }) => (
                  <Input
                    {...field}
                    id="t-code"
                    type="password"
                    placeholder="Von der Schulverwaltung erhalten"
                    aria-invalid={!!errors.accessCode}
                  />
                )}
              />
              <FieldError errors={[errors.accessCode]} />
            </Field>

            <PrivacyCheckboxField
              control={control}
              id="t-acceptPrivacy"
              error={errors.acceptPrivacy}
            />
          </FieldGroup>

          <CapWidget key={signUpCapKey} onSolve={setSignUpCapToken} />
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Wird registriert…
              </>
            ) : (
              "Lehrerkonto erstellen"
            )}
          </Button>
        </form>
      </CardContent>
      <CardFooter className="flex flex-col gap-2 text-sm text-muted-foreground">
        <span>
          Bereits ein Konto?{" "}
          <Link
            href="/login"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Anmelden
          </Link>
        </span>
        <span>
          Schüler?{" "}
          <Link
            href="/register"
            className="text-foreground underline-offset-4 hover:underline"
          >
            Schülerkonto erstellen
          </Link>
        </span>
      </CardFooter>
    </Card>
  )
}
