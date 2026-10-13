"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"

import { authClient } from "@/lib/auth-client"
import {
  changePasswordSchema,
  type ChangePasswordInput,
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

interface PasswordFormProps {
  hasPassword: boolean
}

export function PasswordForm({ hasPassword }: PasswordFormProps) {
  const [error, setError] = useState<string | null>(null)

  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting, errors },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  })

  async function onSubmit(data: ChangePasswordInput) {
    setError(null)
    try {
      const { error } = await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: true,
      })
      if (error) {
        setError(authErrorMessage(error, "Fehler beim Ändern des Passworts."))
        return
      }
      toast.success("Passwort geändert")
      reset()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Verbindungsfehler. Bitte versuchen Sie es erneut."
      )
    }
  }

  if (!hasPassword) {
    return (
      <SettingsSection title="Passwort">
        <Alert>
          <AlertDescription>
            Ihr Konto verwendet die Microsoft-Anmeldung. Ein Passwort kann nur
            für Konten mit E-Mail-Anmeldung geändert werden.
          </AlertDescription>
        </Alert>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title="Passwort"
      description="Nach der Änderung werden alle anderen Sitzungen abgemeldet."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field data-invalid={!!errors.currentPassword}>
            <FieldLabel htmlFor="currentPassword">
              Aktuelles Passwort
            </FieldLabel>
            <Controller
              name="currentPassword"
              control={control}
              render={({ field }) => (
                <Input
                  {...field}
                  id="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={!!errors.currentPassword}
                />
              )}
            />
            <FieldError errors={[errors.currentPassword]} />
          </Field>
          <Field data-invalid={!!errors.newPassword}>
            <FieldLabel htmlFor="newPassword">Neues Passwort</FieldLabel>
            <Controller
              name="newPassword"
              control={control}
              render={({ field }) => (
                <Input
                  {...field}
                  id="newPassword"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!errors.newPassword}
                />
              )}
            />
            <FieldError errors={[errors.newPassword]} />
          </Field>
          <Field data-invalid={!!errors.confirmPassword}>
            <FieldLabel htmlFor="confirmPassword">
              Neues Passwort bestätigen
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
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Spinner data-icon="inline-start" />
              Wird gespeichert…
            </>
          ) : (
            "Passwort ändern"
          )}
        </Button>
      </form>
    </SettingsSection>
  )
}
