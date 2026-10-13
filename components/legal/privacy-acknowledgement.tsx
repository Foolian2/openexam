"use client"

import Link from "next/link"
import {
  Controller,
  type Control,
  type FieldError as RHFFieldError,
  type FieldValues,
  type Path,
} from "react-hook-form"

import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"

// New tab: leaving the registration form would discard what was typed.
function PrivacyLink() {
  return (
    <Link
      href="/datenschutz"
      target="_blank"
      rel="noopener"
      className="text-foreground underline underline-offset-4"
    >
      Datenschutzerklärung
    </Link>
  )
}

/**
 * "Ich habe die Datenschutzerklärung gelesen" for the registration forms.
 * The form value is `acceptPrivacy`; lib/auth.ts rejects a sign-up without
 * it, so this checkbox is UI for a server-side rule, not the rule itself.
 */
export function PrivacyCheckboxField<T extends FieldValues>({
  control,
  id,
  error,
}: {
  control: Control<T>
  id: string
  error?: RHFFieldError
}) {
  return (
    <Field orientation="horizontal" data-invalid={!!error}>
      <Controller
        name={"acceptPrivacy" as Path<T>}
        control={control}
        render={({ field }) => (
          <Checkbox
            id={id}
            name={field.name}
            checked={field.value === true}
            onCheckedChange={(checked) => field.onChange(checked === true)}
            onBlur={field.onBlur}
            ref={field.ref}
            aria-invalid={!!error}
          />
        )}
      />
      <FieldContent>
        <FieldLabel htmlFor={id} className="font-normal">
          <span>
            Ich habe die <PrivacyLink /> gelesen.
          </span>
        </FieldLabel>
        <FieldError errors={[error]} />
      </FieldContent>
    </Field>
  )
}

/** Microsoft sign-in has no form, so the notice is the acknowledgement. */
export function SsoPrivacyNotice() {
  return (
    <p className="text-xs text-muted-foreground">
      Mit der Anmeldung über Microsoft bestätigen Sie, die <PrivacyLink />{" "}
      gelesen zu haben.
    </p>
  )
}
