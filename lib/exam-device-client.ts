import { apiMutate } from "@/lib/api-mutate"
import type { ApiErrorCode } from "@/lib/api-response"
import { sebFetch } from "@/lib/seb-client"

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; status: number; code: ApiErrorCode | null; message: string }

/**
 * Claims the exam session for this login and browser tab, making it the
 * one the server accepts saves from (lib/exam-device.ts). Failures carry the
 * status and code: a rate limit, a missing SEB or an expired login each need
 * different advice than "reload".
 */
export async function claimExamDevice(
  sessionId: string
): Promise<ClaimOutcome> {
  const result = await apiMutate(`/api/sessions/${sessionId}/device`, {
    fetcher: sebFetch,
    fallbackError: "Prüfung konnte nicht übernommen werden.",
    networkError: "Netzwerkfehler. Bitte Verbindung prüfen und neu laden.",
  })
  if (result.ok) return { ok: true }
  return {
    ok: false,
    status: result.status,
    code: result.code,
    message: result.message,
  }
}

/** Student-facing text for a failed claim. */
export function claimFailureMessage(
  outcome: Extract<ClaimOutcome, { ok: false }>
): string {
  if (outcome.status === 401)
    return "Ihre Anmeldung ist abgelaufen. Bitte melden Sie sich erneut an."
  if (outcome.status === 429)
    return "Zu viele Versuche. Bitte warten Sie eine Minute und laden Sie dann neu."
  return outcome.message
}

// Components deep in the question tree (the file upload viewer) learn about a
// takeover from their own requests; the runner owns the takeover screen.
const replacedEvents = new EventTarget()

export function reportSessionReplaced(sessionId: string): void {
  replacedEvents.dispatchEvent(
    new CustomEvent("replaced", { detail: sessionId })
  )
}

export function onSessionReplaced(
  sessionId: string,
  listener: () => void
): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<string>).detail === sessionId) listener()
  }
  replacedEvents.addEventListener("replaced", handler)
  return () => replacedEvents.removeEventListener("replaced", handler)
}
