import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Prüfung verlassen — OpenExam",
}

/**
 * The SEB quit URL (see `buildSebSettings`). SEB quits the moment it *loads*
 * this URL, so inside SEB this page is essentially never painted — it exists so
 * that the navigation has a real destination, and so that a student who lands
 * here in a normal browser sees something sensible.
 *
 * Deliberately inert: no auth, no data, and above all no redirects. Nothing else
 * in the app may navigate here, or SEB would quit at a moment we never intended.
 */
export default function ExamQuitPage() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Prüfung verlassen</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Deine Antworten wurden abgegeben. Safe Exam Browser wird beendet — du kannst
          dieses Fenster jetzt schliessen.
        </p>
      </div>
    </div>
  )
}
