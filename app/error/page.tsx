import type { Metadata } from "next"
import Link from "next/link"
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CenteredPage } from "@/components/auth/centered-page"

export const metadata: Metadata = {
  title: "Fehler — OpenExam",
}

// Better Auth redirects failed auth requests here (see onAPIError.errorURL in
// lib/auth.ts) with an `error` code and, sometimes, an `error_description`.
// Both are fully attacker-controlled — this route can be hit directly with
// any query string, with no OAuth flow involved, and `error_description` in
// particular can carry arbitrary freeform text from an OAuth provider (or
// anyone spoofing one). Never render either value verbatim: that would let
// an attacker use our own domain and UI chrome to display arbitrary text
// (a content-spoofing/phishing vector), even though React's escaping rules
// out actual HTML/script injection. Instead, only ever display our own
// canned copy, looked up from a fixed allowlist of known codes.
const ERROR_MESSAGES: Record<string, string> = {
  SCHOOL_DOMAIN_REQUIRED:
    "Die Anmeldung mit Microsoft ist nur mit einem Schulkonto möglich.",
  access_denied: "Die Anmeldung wurde abgebrochen.",
  email_is_missing:
    "Ihr Microsoft-Konto hat keine E-Mail-Adresse zurückgegeben.",
  // Renamed in better-auth 1.7 (was "email_doesn't_match"); the old spelling
  // stays mapped so a redirect issued just before the deploy still resolves.
  email_does_not_match:
    "Diese E-Mail-Adresse stimmt nicht mit dem verknüpften Konto überein.",
  "email_doesn't_match":
    "Diese E-Mail-Adresse stimmt nicht mit dem verknüpften Konto überein.",
  // An existing password account whose address isn't confirmed yet: Microsoft
  // sign-in is linked to it only after verification (lib/auth.ts).
  account_not_linked:
    "Für diese E-Mail-Adresse besteht bereits ein Konto, das noch nicht bestätigt ist. Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse über den Link in der Bestätigungs-E-Mail.",
  account_already_linked_to_different_user:
    "Dieses Microsoft-Konto ist bereits mit einem anderen Benutzer verknüpft.",
}

const FALLBACK_MESSAGE =
  "Bei der Anmeldung ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut."

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const message = (error && ERROR_MESSAGES[error]) || FALLBACK_MESSAGE

  return (
    <CenteredPage>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="contents">Anmeldung fehlgeschlagen</h1>
          </CardTitle>
          <CardDescription>
            Bei der Anmeldung ist ein Fehler aufgetreten.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertCircle />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <Button asChild className="w-full">
            <Link href="/login">Zurück zur Anmeldung</Link>
          </Button>
        </CardFooter>
      </Card>
    </CenteredPage>
  )
}
