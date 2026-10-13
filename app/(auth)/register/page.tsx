import type { Metadata } from "next"
import { connection } from "next/server"
import { RegisterForm } from "@/components/auth/register-form"
import { microsoftConfigured } from "@/lib/env"

export const metadata: Metadata = {
  title: "Registrieren — OpenExam",
}

export default async function RegisterPage() {
  // This page reads no request-time API (no cookies/headers/searchParams), so
  // without this it is prerendered at build time — and the Docker build
  // deliberately sets no MICROSOFT_* vars, which baked microsoftEnabled=false
  // into the HTML: deployments with Microsoft login configured never saw the
  // sign-in button. connection() defers the render to request time, where
  // process.env actually holds the deployment's values.
  await connection()
  return <RegisterForm microsoftEnabled={microsoftConfigured()} />
}
