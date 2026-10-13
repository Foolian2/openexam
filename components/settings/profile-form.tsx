"use client"

import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { authClient } from "@/lib/auth-client"
import {
  updateProfileSchema,
  type UpdateProfileInput,
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

interface ProfileFormProps {
  initialName: string
}

export function ProfileForm({ initialName }: ProfileFormProps) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const {
    control,
    handleSubmit,
    reset,
    formState: { isSubmitting, isDirty, errors },
  } = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: { name: initialName },
  })

  async function onSubmit(data: UpdateProfileInput) {
    setError(null)
    try {
      const { error } = await authClient.updateUser({ name: data.name })
      if (error) {
        setError(authErrorMessage(error, "Fehler beim Speichern."))
        return
      }
      toast.success("Name aktualisiert")
      reset({ name: data.name })
      router.refresh()
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Verbindungsfehler. Bitte versuchen Sie es erneut."
      )
    }
  }

  return (
    <SettingsSection title="Profil" description="Ihr Anzeigename in OpenExam.">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
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
                  autoComplete="name"
                  aria-invalid={!!errors.name}
                />
              )}
            />
            <FieldError errors={[errors.name]} />
          </Field>
        </FieldGroup>
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? (
            <>
              <Spinner data-icon="inline-start" />
              Wird gespeichert…
            </>
          ) : (
            "Speichern"
          )}
        </Button>
      </form>
    </SettingsSection>
  )
}
