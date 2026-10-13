import { z } from "zod"
import { displayNameSchema } from "@/lib/display-name"

export const loginSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
  password: z.string().min(8, "Passwort muss mindestens 8 Zeichen haben"),
})

export const registerSchema = z
  .object({
    name: displayNameSchema,
    email: z.string().email("Ungültige E-Mail-Adresse"),
    password: z
      .string()
      .min(8, "Passwort muss mindestens 8 Zeichen haben")
      .max(128, "Passwort darf maximal 128 Zeichen haben"),
    confirmPassword: z.string(),
    // Enforced again server-side (lib/auth.ts privacyAcceptanceFields).
    acceptPrivacy: z.boolean().refine((v) => v === true, {
      message:
        "Bitte bestätigen Sie, dass Sie die Datenschutzerklärung gelesen haben.",
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwörter stimmen nicht überein",
    path: ["confirmPassword"],
  })

export const forgotPasswordSchema = z.object({
  email: z.string().email("Ungültige E-Mail-Adresse"),
})

export const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, "Passwort muss mindestens 8 Zeichen haben")
      .max(128, "Passwort darf maximal 128 Zeichen haben"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwörter stimmen nicht überein",
    path: ["confirmPassword"],
  })

export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
