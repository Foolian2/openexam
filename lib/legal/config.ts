import { getEnv, microsoftConfigured } from "@/lib/env"

/**
 * Bump when the Datenschutzerklärung changes materially. Stored on the user
 * row at registration (User.privacyPolicyVersion) so it stays provable which
 * text an account acknowledged. LEGAL_POLICY_VERSION overrides it for
 * operator-side wording changes that don't touch this template.
 */
export const PRIVACY_POLICY_VERSION = "2026-09-16"

/** Written to AuditLog.action when an account acknowledges the policy. */
export const PRIVACY_ACCEPTED_AUDIT_ACTION = "PRIVACY_POLICY_ACCEPTED"

export const DEFAULT_RETENTION_NOTE =
  "Die Aufbewahrungsdauer von Prüfungsdaten, Bewertungen und Protokollen richtet sich nach den Vorgaben der Schule bzw. des kantonalen Rechts. Daten, die nicht mehr benötigt werden, werden von der Schule gelöscht oder anonymisiert."

export interface LegalConfig {
  controllerName: string
  /** One line per array entry (LEGAL_CONTROLLER_ADDRESS uses "\n"). */
  controllerAddress: string[]
  contactEmail: string
  contactPhone: string | null
  hostingProvider: string
  dpoName: string | null
  dpoEmail: string | null
  impressumResponsible: string | null
  retentionNote: string
  policyVersion: string
  microsoftLoginEnabled: boolean
  errorTrackingEnabled: boolean
  /** Encrypted wal-g backups leave the server (WALG_STORAGE_BACKEND=sftp). */
  offsiteBackupEnabled: boolean
  backupProvider: string | null
}

// Development-only fallbacks: production refuses to boot without the real
// values (lib/env.ts LEGAL_REQUIRED_IN_PROD), so these never reach students.
const DEV_FALLBACK = {
  controllerName: "Beispielschule (LEGAL_CONTROLLER_NAME setzen)",
  controllerAddress: "Musterstrasse 1\n8000 Zürich",
  contactEmail: "datenschutz@example.com",
  hostingProvider: "Eigener Server (LEGAL_HOSTING_PROVIDER setzen)",
}

// Reads process.env directly rather than getEnv(): it runs inside the
// Better Auth user.create hook, which must not turn an unrelated env issue
// into a failed sign-up (instrumentation.ts already refuses to boot on one).
export function getPrivacyPolicyVersion(): string {
  return process.env.LEGAL_POLICY_VERSION?.trim() || PRIVACY_POLICY_VERSION
}

export function getLegalConfig(): LegalConfig {
  const env = getEnv()
  const address = env.LEGAL_CONTROLLER_ADDRESS ?? DEV_FALLBACK.controllerAddress
  return {
    controllerName: env.LEGAL_CONTROLLER_NAME ?? DEV_FALLBACK.controllerName,
    // .env files can't hold literal newlines in an unquoted value, so the
    // two-character sequence "\n" is accepted as a line break too.
    controllerAddress: address
      .split(/\\n|\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    contactEmail: env.LEGAL_CONTACT_EMAIL ?? DEV_FALLBACK.contactEmail,
    contactPhone: env.LEGAL_CONTACT_PHONE ?? null,
    hostingProvider: env.LEGAL_HOSTING_PROVIDER ?? DEV_FALLBACK.hostingProvider,
    dpoName: env.LEGAL_DPO_NAME ?? null,
    dpoEmail: env.LEGAL_DPO_EMAIL ?? null,
    impressumResponsible: env.LEGAL_IMPRESSUM_RESPONSIBLE ?? null,
    retentionNote: env.LEGAL_RETENTION_NOTE ?? DEFAULT_RETENTION_NOTE,
    policyVersion: getPrivacyPolicyVersion(),
    microsoftLoginEnabled: microsoftConfigured(),
    errorTrackingEnabled: Boolean(env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN),
    offsiteBackupEnabled: env.WALG_STORAGE_BACKEND === "sftp",
    backupProvider: env.LEGAL_BACKUP_PROVIDER ?? null,
  }
}
