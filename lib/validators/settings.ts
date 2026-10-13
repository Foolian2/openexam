import { z } from "zod"
import { displayNameSchema } from "@/lib/display-name"

export const updateProfileSchema = z.object({
  name: displayNameSchema,
})

export const changeEmailSchema = z.object({
  email: z.email("Ungültige E-Mail-Adresse"),
})

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Aktuelles Passwort ist erforderlich"),
    newPassword: z
      .string()
      .min(8, "Passwort muss mindestens 8 Zeichen haben")
      .max(128, "Passwort darf maximal 128 Zeichen haben"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwörter stimmen nicht überein",
    path: ["confirmPassword"],
  })

export const updateUserRoleSchema = z.object({
  role: z.enum(["STUDENT", "TEACHER", "ADMIN"], { error: "Ungültige Rolle" }),
})

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>
