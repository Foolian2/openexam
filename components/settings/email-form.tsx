"use client"

import { useState } from "react"
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
}

export function EmailForm({ currentEmail, callbackURL }: EmailFormProps) {
  const [error, setError] = useState<string | null>(null)

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
        callbackURL,
      })
      if (error) {
        setError(
          authErrorMessage(error, "Fehler beim Ändern der E-Mail-Adresse.")
        )
        return
      }
      toast.success(`Bestätigungslink an ${currentEmail} gesendet`)
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
      description="Sie erhalten einen Bestätigungslink an Ihre aktuelle E-Mail-Adresse. Die neue Adresse wird erst nach der Bestätigung wirksam."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
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
