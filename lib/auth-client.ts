"use client"

import { createAuthClient } from "better-auth/react"
import { inferAdditionalFields } from "better-auth/client/plugins"
import { passkeyClient } from "@better-auth/passkey/client"
import type { auth } from "./auth"

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000",
  // No generic-OAuth client plugin: since better-auth 1.7 generic providers
  // are driven through the standard social client APIs (signIn.social /
  // linkSocial), and the plugin no longer ships one.
  plugins: [passkeyClient(), inferAdditionalFields<typeof auth>()],
})

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  requestPasswordReset,
  resetPassword,
} = authClient
