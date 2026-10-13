import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"

import {
  ControllerAddress,
  LegalSection,
  LegalTitle,
} from "@/components/legal/legal-text"
import { getLegalConfig } from "@/lib/legal/config"

export const metadata: Metadata = {
  title: "Impressum — OpenExam",
}

export default async function ImpressumPage() {
  // Request-time render for the runtime env vars — see the Datenschutz page.
  await connection()
  const config = getLegalConfig()

  return (
    <article>
      <LegalTitle>Impressum</LegalTitle>

      <LegalSection title="Betreiberin">
        <ControllerAddress config={config} />
      </LegalSection>

      {config.impressumResponsible && (
        <LegalSection title="Verantwortlich für den Inhalt">
          <p>{config.impressumResponsible}</p>
        </LegalSection>
      )}

      <LegalSection title="Software">
        <p>
          Diese Prüfungsplattform basiert auf OpenExam, einer quelloffenen
          Software unter der GNU Affero General Public License v3 (AGPLv3). Der
          Quellcode ist öffentlich einsehbar. Die Entwicklerinnen und Entwickler
          der Software sind nicht Betreiber dieser Installation und haben keinen
          Zugriff auf die hier gespeicherten Daten.
        </p>
      </LegalSection>

      <LegalSection title="Datenschutz">
        <p>
          Informationen zur Bearbeitung Ihrer Personendaten finden Sie in der{" "}
          <Link href="/datenschutz" className="underline underline-offset-4">
            Datenschutzerklärung
          </Link>
          .
        </p>
      </LegalSection>
    </article>
  )
}
