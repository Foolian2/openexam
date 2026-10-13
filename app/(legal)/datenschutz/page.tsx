import type { Metadata } from "next"
import Link from "next/link"
import { connection } from "next/server"

import {
  ControllerAddress,
  LegalList,
  LegalSection,
  LegalTitle,
  MailLink,
} from "@/components/legal/legal-text"
import { StorageTable } from "@/components/legal/storage-table"
import { getLegalConfig } from "@/lib/legal/config"

export const metadata: Metadata = {
  title: "Datenschutzerklärung — OpenExam",
}

export default async function DatenschutzPage() {
  // The operator's details come from runtime env vars (lib/legal/config.ts),
  // and the Docker image is built once for every school — prerendering this
  // at build time would freeze the development placeholders into the HTML.
  await connection()
  const config = getLegalConfig()

  return (
    <article>
      <LegalTitle updated={config.policyVersion}>
        Datenschutzerklärung
      </LegalTitle>

      <p className="leading-relaxed">
        Diese Datenschutzerklärung informiert Sie darüber, welche Personendaten
        bei der Nutzung der Prüfungsplattform OpenExam bearbeitet werden, zu
        welchem Zweck das geschieht und welche Rechte Sie haben. OpenExam wird
        von der unten genannten Schule selbst betrieben. Prüfungsdaten werden nicht
        an Werbe-, Analyse- oder Trackingdienste weitergegeben. Technische
        Anfragen an externe Dienste sind unten beschrieben.
      </p>

      <LegalSection title="Verantwortliche Stelle">
        <ControllerAddress config={config} />
      </LegalSection>

      {(config.dpoName || config.dpoEmail) && (
        <LegalSection title="Datenschutzbeauftragte Person">
          <p>
            {config.dpoName && <span className="block">{config.dpoName}</span>}
            {config.dpoEmail && (
              <span className="block">
                E-Mail: <MailLink email={config.dpoEmail} />
              </span>
            )}
          </p>
        </LegalSection>
      )}

      <LegalSection title="Welche Daten wir bearbeiten">
        <LegalList
          items={[
            <>
              <strong>Konto:</strong> Name, E-Mail-Adresse, Rolle (Schüler/in,
              Lehrperson, Administration), Passwort (nur als sicherer Hash-Wert
              gespeichert), gegebenenfalls registrierte Passkeys sowie Ihre
              Anzeige-Einstellungen (z. B. Schriftart für Legasthenie, hoher
              Kontrast).
            </>,
            <>
              <strong>Anmeldesitzungen:</strong> Zeitpunkt, IP-Adresse und
              Browserkennung (User-Agent) der Anmeldung.
            </>,
            <>
              <strong>Prüfungsdaten:</strong> Ihre Antworten, hochgeladene
              Dateien, Beginn- und Abgabezeitpunkt, Bewertungen und
              Rückmeldungen der Lehrperson sowie allfällige Zeitverlängerungen
              oder Nachteilsausgleiche.
            </>,
            <>
              <strong>Prüfungsaufsicht:</strong> Während einer Prüfung sieht die
              Lehrperson Ihren Verbindungsstatus und Fortschritt. Zudem werden
              Hinweise auf mögliche Unregelmässigkeiten gespeichert (z. B.
              Wechsel des Fensters oder Tabs, blockiertes Kopieren oder
              Einfügen). Es findet keine Überwachung per Kamera oder Mikrofon
              statt, und es erfolgt keine automatisierte Bewertung Ihres
              Verhaltens.
            </>,
            <>
              <strong>Protokolle:</strong> Wichtige Vorgänge rund um Prüfungen
              (z. B. Abgabe, Bewertung, Veröffentlichung, Export) werden mit
              Zeitpunkt, Konto und IP-Adresse in einem Audit-Protokoll
              festgehalten; in einzelnen Fällen — etwa beim Herunterladen der
              SEB-Konfiguration — zusätzlich die Browserkennung. Der Webserver
              protokolliert ausserdem technische Zugriffsdaten.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="Zweck und Rechtsgrundlage">
        <p>
          Die Daten werden ausschliesslich zur Durchführung, Aufsicht, Bewertung
          und Nachvollziehbarkeit von Prüfungen sowie zum sicheren Betrieb der
          Plattform bearbeitet. Grundlage ist der gesetzliche Bildungsauftrag
          der Schule nach dem anwendbaren kantonalen Datenschutzrecht bzw. dem
          Bundesgesetz über den Datenschutz (DSG); soweit die
          Datenschutz-Grundverordnung (DSGVO) anwendbar ist, Art. 6 Abs. 1 lit.
          e DSGVO (Wahrnehmung einer Aufgabe im öffentlichen Interesse).
        </p>
      </LegalSection>

      <LegalSection title="Hosting und Empfänger">
        <p>
          OpenExam wird auf eigener Infrastruktur der Schule betrieben:{" "}
          {config.hostingProvider}. Datenbank, Dateiablage und alle Hilfsdienste
          (z. B. Bot-Schutz und Fehlerprotokollierung) laufen auf diesem Server.
          Schriftarten werden lokal ausgeliefert.
        </p>
        {config.offsiteBackupEnabled && (
          <p>
            <strong>Sicherungskopien:</strong> Zum Schutz vor Datenverlust
            werden Sicherungskopien der Datenbank zusätzlich auf einen separaten
            Sicherungsserver übertragen
            {config.backupProvider ? <> ({config.backupProvider})</> : null}.
            Die Kopien werden vor der Übertragung auf dem Server der Schule
            verschlüsselt; der Betreiber des Sicherungsservers kann ihren Inhalt
            nicht lesen.
          </p>
        )}
        <p>
          <strong>Externe Programmdateien:</strong> Der Browser lädt das
          Bot-Schutz-Widget auf den Anmelde- und Registrierungsseiten sowie
          den Code-Editor bei Programmieraufgaben vom Content-Delivery-Netzwerk
          jsDelivr (cdn.jsdelivr.net). Dabei erhält der CDN-Anbieter technische
          Anfragedaten, insbesondere Ihre IP-Adresse und Browserkennung.
          Prüfungsantworten werden mit diesen Anfragen nicht übertragen; die
          Prüfung des Bot-Schutzes erfolgt auf dem Server der Schule.
        </p>
        <p>
          Zugriff auf Ihre Prüfungsdaten haben die Lehrpersonen der betreffenden
          Prüfung sowie die mit dem Betrieb betrauten Administratorinnen und
          Administratoren der Schule. E-Mails (z. B. zur Bestätigung Ihrer
          E-Mail-Adresse) werden über den von der Schule festgelegten
          E-Mail-Versanddienst verschickt.
        </p>
        {config.microsoftLoginEnabled && (
          <p>
            <strong>Anmeldung mit Microsoft:</strong> Wenn Sie sich mit Ihrem
            Schulkonto über Microsoft anmelden, erfolgt die Anmeldung bei
            Microsoft (Microsoft Entra ID, Mandant der Schule). Microsoft
            übermittelt dabei Ihren Namen und Ihre E-Mail-Adresse an OpenExam.
            Für die Bearbeitung bei Microsoft gelten die Vereinbarungen der
            Schule mit Microsoft.
          </p>
        )}
      </LegalSection>

      <LegalSection title="Safe Exam Browser">
        <p>
          Für gesicherte Prüfungen wird der Safe Exam Browser (SEB) eingesetzt,
          den Sie selbst auf Ihrem Gerät installieren. SEB sperrt während der
          Prüfung andere Programme und übermittelt an OpenExam lediglich
          technische Prüfwerte, mit denen erkannt wird, ob die Prüfung in einem
          korrekt konfigurierten SEB läuft. OpenExam übermittelt dabei keine
          Daten an Dritte.
        </p>
      </LegalSection>

      {config.errorTrackingEnabled && (
        <LegalSection title="Fehlerprotokollierung">
          <p>
            Tritt in der Anwendung ein technischer Fehler auf, wird ein
            Fehlerbericht (Fehlermeldung, betroffene Seite, Browsertyp) an ein
            auf dem Server der Schule selbst betriebenes Fehlerprotokoll
            (GlitchTip) übermittelt. Die Berichte dienen ausschliesslich der
            Fehlerbehebung und werden nicht an Dritte weitergegeben.
          </p>
        </LegalSection>
      )}

      <LegalSection id="cookies" title="Cookies und lokaler Speicher">
        <p>
          OpenExam verwendet ausschliesslich Cookies und Browserspeicher, die
          für den Betrieb technisch notwendig sind oder eine von Ihnen gewählte
          Einstellung speichern. Es werden keine Tracking-, Analyse- oder
          Werbe-Cookies eingesetzt. Die oben beschriebenen CDN-Anfragen erfolgen
          unabhängig von diesen Speichereinträgen. Eine
          Einwilligung ist dafür nicht erforderlich; deshalb zeigt OpenExam kein
          Cookie-Banner an.
        </p>
        <StorageTable />
        <p className="text-sm text-muted-foreground">
          Sie können Cookies und lokalen Speicher in Ihrem Browser jederzeit
          löschen. Ohne das Anmelde-Cookie ist OpenExam jedoch nicht nutzbar,
          und noch nicht übertragene Antworten einer laufenden Prüfung könnten
          verloren gehen.
        </p>
      </LegalSection>

      <LegalSection title="Aufbewahrung">
        <p>{config.retentionNote}</p>
      </LegalSection>

      <LegalSection title="Ihre Rechte">
        <p>
          Sie haben im Rahmen des anwendbaren Rechts insbesondere folgende
          Rechte:
        </p>
        <LegalList
          items={[
            "Auskunft darüber, welche Daten über Sie bearbeitet werden, und Herausgabe dieser Daten",
            "Berichtigung unrichtiger Daten (Name und Einstellungen können Sie selbst in Ihrem Profil ändern)",
            "Löschung oder Anonymisierung, soweit keine gesetzliche Aufbewahrungspflicht entgegensteht",
            "Einschränkung der Bearbeitung und Widerspruch",
            "Beschwerde bei der zuständigen Datenschutz-Aufsichtsbehörde",
          ]}
        />
        <p>
          Wenden Sie sich dazu an <MailLink email={config.contactEmail} />
          {config.dpoEmail && (
            <>
              {" "}
              oder an die datenschutzbeauftragte Person unter{" "}
              <MailLink email={config.dpoEmail} />
            </>
          )}
          .
        </p>
      </LegalSection>

      <LegalSection title="Änderungen">
        <p>
          Diese Datenschutzerklärung kann angepasst werden, wenn sich die
          Plattform oder die rechtlichen Vorgaben ändern. Es gilt die jeweils
          hier veröffentlichte Fassung (Stand: {config.policyVersion}). Siehe
          auch das{" "}
          <Link href="/impressum" className="underline underline-offset-4">
            Impressum
          </Link>
          .
        </p>
      </LegalSection>
    </article>
  )
}
