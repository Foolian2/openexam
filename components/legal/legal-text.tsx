import type { LegalConfig } from "@/lib/legal/config"

// Minimal typography for the legal pages — the project has no
// @tailwindcss/typography, and these two pages don't justify adding it.

export function LegalTitle({
  children,
  updated,
}: {
  children: React.ReactNode
  updated?: string
}) {
  return (
    <header className="mb-8 space-y-2">
      <h1 className="text-3xl font-bold tracking-tight">{children}</h1>
      {updated && (
        <p className="text-sm text-muted-foreground">Stand: {updated}</p>
      )}
    </header>
  )
}

export function LegalSection({
  id,
  title,
  children,
}: {
  id?: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="mt-10 scroll-mt-6 space-y-3 first:mt-0">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="space-y-3 leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  )
}

export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-6">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}

export function MailLink({ email }: { email: string }) {
  return (
    <a
      href={`mailto:${email}`}
      className="text-foreground underline underline-offset-4"
    >
      {email}
    </a>
  )
}

/** Controller block shared by Datenschutzerklärung and Impressum. */
export function ControllerAddress({ config }: { config: LegalConfig }) {
  return (
    <address className="not-italic">
      <strong>{config.controllerName}</strong>
      {config.controllerAddress.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
      <span className="block">
        E-Mail: <MailLink email={config.contactEmail} />
      </span>
      {config.contactPhone && (
        <span className="block">Telefon: {config.contactPhone}</span>
      )}
    </address>
  )
}
