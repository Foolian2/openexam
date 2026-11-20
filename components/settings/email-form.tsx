"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"

import { authClient } from "@/lib/auth-client"
import {
  changeEmailSchema,
  type ChangeEmailInput,
} from "@/lib/validators/settings"
import { SettingsSection } from "@/components/settings/settings-section"
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
import { authErrorMessage } from "@/lib/auth-error-message"

interface EmailFormProps {
  currentEmail: string
  callbackURL: string
  // Address of the email change the links redirected back for, verified
  // server-side from its signed query parameter (lib/email-change-state.ts);
  // null when there is none or it does not verify.
  requestedEmail: string | null
}

// Query parameter the change-email links redirect back with; the name must
// match EMAIL_CHANGE_PARAM in lib/email-change-state.ts (server-only).
// better-auth reuses one callbackURL for both links of the flow (see
// user.changeEmail in lib/auth.ts), so the page tells the steps apart by
// comparing the requested address with the session's: still different after
// the first link, equal once the second has switched the account over.
const EMAIL_CHANGE_PARAM = "emailChange"

// Errors better-auth's verify-email redirect appends to the callbackURL. The
// shared authErrorMessage() texts are worded for the login form (its
// USER_NOT_FOUND reads "E-Mail-Adresse oder Passwort ist falsch"), which is
// wrong for a link: USER_NOT_FOUND here means the account no longer has the
// address the link was issued for, e.g. a competing change completed first.
const LINK_ERRORS: Record<string, string> = {
  USER_NOT_FOUND:
    "Dieser Link ist nicht mehr gültig. Die E-Mail-Adresse des Kontos hat sich inzwischen geändert.",
  INVALID_TOKEN: "Der Link ist ungültig oder abgelaufen.",
  TOKEN_EXPIRED:
    "Der Link ist abgelaufen. Bitte fordern Sie die Änderung erneut an.",
}

function linkErrorMessage(code: string): string {
  return (
    LINK_ERRORS[code] ??
    authErrorMessage(
      { code },
      "Die E-Mail-Adresse konnte nicht geändert werden."
    )
  )
}

export function EmailForm({
  currentEmail,
  callbackURL,
  requestedEmail,
}: EmailFormProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  // Read once on mount: the effect below strips the parameters again.
  const [requested, setRequested] = useState(requestedEmail)
  const [error, setError] = useState<string | null>(() => {
    // better-auth appends ?error=<CODE> when a link is invalid or expired.
    const linkError = searchParams.get("error")
    return linkError ? linkErrorMessage(linkError) : null
  })
  const changed =
    !!requested && requested.toLowerCase() === currentEmail.toLowerCase()
  const pendingEmail = requested && !changed && !error ? requested : null

  useEffect(() => {
    if (!searchParams.has(EMAIL_CHANGE_PARAM) && !searchParams.has("error")) {
      return
    }
    if (changed) toast.success("E-Mail-Adresse geändert")
    // Drop the parameters so a reload doesn't repeat the message.
    router.replace(pathname, { scroll: false })
  }, [searchParams, changed, router, pathname])

  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<ChangeEmailInput>({
    resolver: zodResolver(changeEmailSchema),
    defaultValues: { email: "" },
  })

  async function onSubmit(data: ChangeEmailInput) {
    setError(null)
    try {
      const { error } = await authClient.changeEmail({
        newEmail: data.email,
        // lib/auth.ts adds the signed email-change parameter to this.
        callbackURL,
      })
      if (error) {
        setError(
          authErrorMessage(error, "Fehler beim Ändern der E-Mail-Adresse.")
        )
        return
      }
      toast.success(`Bestätigungslink an ${currentEmail} gesendet`)
      setRequested(null)
      reset()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Verbindungsfehler. Bitte versuchen Sie es erneut."
      )
    }
  }

  return (
    <SettingsSection
      title="E-Mail-Adresse"
      description="Sie erhalten zuerst einen Bestätigungslink an Ihre aktuelle E-Mail-Adresse, danach einen zweiten an die neue. Die neue Adresse wird erst wirksam, wenn Sie beide Links geöffnet haben."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {pendingEmail && (
          <Alert>
            <AlertDescription>
              Änderung bestätigt. Wir haben einen zweiten Link an {pendingEmail}{" "}
              gesendet. Öffnen Sie ihn, um die neue Adresse zu aktivieren.
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="current-email">
              Aktuelle E-Mail-Adresse
            </FieldLabel>
            <Input
              id="current-email"
              type="email"
              value={currentEmail}
              disabled
            />
          </Field>
          <Field data-invalid={!!errors.email}>
            <FieldLabel htmlFor="email">Neue E-Mail-Adresse</FieldLabel>
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
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Spinner data-icon="inline-start" />
              Wird gesendet…
            </>
          ) : (
            "Bestätigungslink senden"
          )}
        </Button>
      </form>
    </SettingsSection>
  )
}
