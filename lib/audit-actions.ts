/**
 * Every `AuditLog.action` value the app currently writes, with a stable
 * German display label — mirrors the TYPE_LABELS pattern in
 * components/questions/question-sheet.tsx. Hardcoded rather than a `SELECT
 * DISTINCT action` query: cheaper, and the labels stay stable even if a
 * given action hasn't fired yet in this database.
 *
 * Non-exam-scoped actions (TEACHER_PROMOTE_*, USER_ROLE_CHANGED,
 * PASSWORD_RESET_COMPLETED,
 * QUESTION_BANK_ITEM_*) are listed for completeness but never appear in the
 * teacher audit-log UI, which is scoped to exam-associated rows only (see
 * lib/audit-log-query.ts).
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  BULK_GRADE_APPLIED: "Massenbewertung angewendet",
  QUESTION_BANK_ITEM_CREATED: "Fragenbank-Eintrag erstellt",
  QUESTION_BANK_ITEM_UPDATED: "Fragenbank-Eintrag bearbeitet",
  QUESTION_BANK_ITEM_DELETED: "Fragenbank-Eintrag gelöscht",
  QUESTION_BANK_ITEM_DUPLICATED: "Fragenbank-Eintrag dupliziert",
  QUESTION_BANK_IMPORT: "Fragenbank-Import",
  QUESTION_BANK_SHARED: "Fragenbank-Eintrag geteilt",
  QUESTION_BANK_SHARE_REVOKED: "Fragenbank-Freigabe aufgehoben",
  QUESTION_BANK_ITEM_PROPAGATED: "Kopien in Prüfungen aktualisiert",
  QUESTION_SAVED_TO_BANK: "Frage in Fragenbank gespeichert",
  QUESTION_BANK_ITEM_MOVED_TO_FOLDER: "Fragenbank-Eintrag verschoben",
  AUDIT_LOG_EXPORTED: "Audit-Log exportiert",
  EXAM_ACTIVATED: "Prüfung gestartet",
  EXAM_ARCHIVED: "Prüfung archiviert",
  EXAM_CLOSED: "Prüfung beendet",
  EXAM_CREATED: "Prüfung erstellt",
  EXAM_DELETED: "Prüfung gelöscht",
  EXAM_DUPLICATED: "Prüfung dupliziert",
  EXAM_GRADED: "Prüfung als bewertet markiert",
  EXAM_MOVED_TO_FOLDER: "Prüfung verschoben",
  EXAM_PRINTED: "Prüfung als PDF gedruckt",
  EXAM_PUBLISHED: "Prüfung veröffentlicht",
  EXAM_UNARCHIVED: "Archivierung aufgehoben",
  EXAM_UPDATED: "Prüfung bearbeitet",
  EXAM_TIME_EXTENDED: "Bearbeitungszeit für alle verlängert",
  FOLDER_CREATED: "Ordner erstellt",
  FOLDER_DELETED: "Ordner gelöscht",
  FOLDER_RENAMED: "Ordner umbenannt",
  QUESTION_ADDED: "Frage hinzugefügt",
  QUESTION_DELETED: "Frage gelöscht",
  QUESTION_UPDATED: "Frage bearbeitet",
  QUESTIONS_REORDERED: "Fragen neu sortiert",
  RESULTS_EXPORTED: "Ergebnisse exportiert",
  RESULT_PDF_DOWNLOADED: "Ergebnis-PDF heruntergeladen",
  SEB_ACCESS_DENIED: "SEB-Zugriff verweigert",
  SEB_INTEGRITY_DENIED: "SEB-Integritätsprüfung fehlgeschlagen",
  SEB_QUIT_PASSWORD_REVEALED: "SEB-Notfall-Passwort angezeigt",
  SEB_CONFIG_DOWNLOADED: "SEB-Konfiguration heruntergeladen",
  SESSION_DEVICE_REPLACED: "Prüfung auf anderem Gerät geöffnet",
  SESSION_EXTENDED: "Bearbeitungszeit verlängert",
  SESSION_GRADED: "Sitzung bewertet",
  SESSION_LOCKED: "Sitzung gesperrt",
  SESSION_RESUMED: "Prüfung fortgesetzt",
  SESSION_STARTED: "Prüfung begonnen",
  SESSION_SUBMITTED: "Prüfung abgegeben",
  SESSION_UNLOCKED: "Sitzung entsperrt",
  SESSION_WAITING: "Warteraum betreten",
  TEACHER_PROMOTE_FAILED: "Lehrkraft-Freischaltung fehlgeschlagen",
  TEACHER_PROMOTE_SUCCESS: "Lehrkraft-Freischaltung erfolgreich",
  TEACHER_PROMOTE_NOOP:
    "Lehrkraft-Freischaltung ohne Wirkung (Rolle bereits geändert)",
  TEACHER_REGISTER_FAILED: "Lehrkraft-Registrierung fehlgeschlagen",
  TEACHER_REGISTER_SUCCESS: "Lehrkraft-Registrierung erfolgreich",
  AUTO_ARCHIVE_ENABLED: "Automatische Archivierung aktiviert",
  AUTO_ARCHIVE_DISABLED: "Automatische Archivierung deaktiviert",
  USER_ROLE_CHANGED: "Rolle geändert",
  PASSWORD_RESET_COMPLETED: "Passwort zurückgesetzt",
  PRIVACY_POLICY_ACCEPTED: "Datenschutzerklärung bestätigt",
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action
}

/**
 * Actions surfaced in the teacher audit-log filter dropdown — exam-scoped
 * only. AUDIT_LOG_EXPORTED is deliberately absent: an export spans a whole
 * role scope rather than one exam, so its rows carry no examId and the
 * teacher view (which requires `examId != null`) can never return them.
 * It stays in the admin filter, which lists every action.
 */
export const EXAM_SCOPED_AUDIT_ACTIONS = [
  "BULK_GRADE_APPLIED",
  "EXAM_ACTIVATED",
  "EXAM_ARCHIVED",
  "EXAM_CLOSED",
  "EXAM_CREATED",
  "EXAM_DELETED",
  "EXAM_DUPLICATED",
  "EXAM_GRADED",
  "EXAM_MOVED_TO_FOLDER",
  "EXAM_PRINTED",
  "EXAM_PUBLISHED",
  "EXAM_UNARCHIVED",
  "EXAM_UPDATED",
  "EXAM_TIME_EXTENDED",
  "QUESTION_ADDED",
  "QUESTION_DELETED",
  "QUESTION_SAVED_TO_BANK",
  "QUESTION_UPDATED",
  "QUESTIONS_REORDERED",
  "RESULTS_EXPORTED",
  "RESULT_PDF_DOWNLOADED",
  "SEB_ACCESS_DENIED",
  "SEB_INTEGRITY_DENIED",
  "SEB_CONFIG_DOWNLOADED",
  "SEB_QUIT_PASSWORD_REVEALED",
  "SESSION_DEVICE_REPLACED",
  "SESSION_EXTENDED",
  "SESSION_GRADED",
  "SESSION_LOCKED",
  "SESSION_RESUMED",
  "SESSION_STARTED",
  "SESSION_SUBMITTED",
  "SESSION_UNLOCKED",
  "SESSION_WAITING",
] as const
