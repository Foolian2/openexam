"use client"

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

/**
 * Root-level error boundary — catches errors that escape every segment's
 * own error.tsx (e.g. a failure in the root layout itself). Next.js
 * replaces the entire document for this boundary, so it renders its own
 * <html>/<body> rather than reusing app/layout.tsx.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    console.error(error)
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="de">
      <body>
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "1.5rem",
            textAlign: "center",
            fontFamily: "sans-serif",
          }}
        >
          <h2>Etwas ist schiefgelaufen</h2>
          <p>
            Die Anwendung konnte nicht geladen werden. Bitte laden Sie die Seite
            neu.
          </p>
        </div>
      </body>
    </html>
  )
}
