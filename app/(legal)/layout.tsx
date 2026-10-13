import Link from "next/link"

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-svh bg-background">
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:py-14">
        <nav
          aria-label="Rechtliches"
          className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
        >
          <Link
            href="/"
            className="text-foreground underline-offset-4 hover:underline"
          >
            ← OpenExam
          </Link>
          <span aria-hidden="true">·</span>
          <Link
            href="/datenschutz"
            className="underline-offset-4 hover:underline"
          >
            Datenschutzerklärung
          </Link>
          <Link
            href="/impressum"
            className="underline-offset-4 hover:underline"
          >
            Impressum
          </Link>
        </nav>
        {children}
      </main>
    </div>
  )
}
