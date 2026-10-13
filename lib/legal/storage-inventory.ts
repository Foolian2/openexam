import {
  EXAM_TEXT_SIZE_KEY,
  PRE_EXAM_THEME_KEY,
  TAB_ID_KEY,
} from "@/lib/pre-exam-theme"
import {
  ANSWER_BUFFER_KEY_PREFIX,
  LAST_QUESTION_TYPE_KEY,
  SESSION_COOKIE_NAMES,
  SESSION_MAX_AGE_SECONDS,
  SIDEBAR_COOKIE_MAX_AGE,
  SIDEBAR_COOKIE_NAME,
  SUBMIT_KEY_PREFIX,
  THEME_STORAGE_KEY,
} from "@/lib/storage-keys"

export type StorageKind = "Cookie" | "localStorage" | "sessionStorage"

export interface StorageEntry {
  /** Exact names as they appear in the browser's developer tools. */
  names: string[]
  kind: StorageKind
  purpose: string
  duration: string
}

function days(seconds: number): string {
  const d = Math.round(seconds / 86_400)
  return d === 1 ? "1 Tag" : `${d} Tage`
}

/**
 * Everything OpenExam stores in the browser, shown as the cookie table on
 * /datenschutz. All entries are technically necessary or remember a setting
 * the user chose, and are distinct from the external CDN requests disclosed on the page.
 * Add new cookies or storage keys
 * here — __tests__/storage-inventory.test.ts pins the exported constants.
 */
export const STORAGE_INVENTORY: StorageEntry[] = [
  {
    names: [...SESSION_COOKIE_NAMES],
    kind: "Cookie",
    purpose:
      "Hält Sie nach der Anmeldung angemeldet. Ohne dieses Cookie ist keine Anmeldung möglich.",
    duration: `${days(SESSION_MAX_AGE_SECONDS)} bzw. bis zur Abmeldung`,
  },
  {
    names: ["better-auth.*", "__Secure-better-auth.*"],
    kind: "Cookie",
    purpose:
      "Kurzlebige technische Cookies während der Anmeldung (z. B. Schutz des Microsoft-Anmeldeablaufs, Passkey-Anmeldung).",
    duration: "Minuten, bis der Anmeldevorgang abgeschlossen ist",
  },
  {
    names: [SIDEBAR_COOKIE_NAME],
    kind: "Cookie",
    purpose:
      "Merkt sich, ob die Seitenleiste im Dashboard auf- oder zugeklappt ist.",
    duration: days(SIDEBAR_COOKIE_MAX_AGE),
  },
  {
    names: [
      `${ANSWER_BUFFER_KEY_PREFIX}:<Sitzung>:<Fenster>`,
      `${ANSWER_BUFFER_KEY_PREFIX}:<Sitzung>:<Fenster>:replaced`,
    ],
    kind: "localStorage",
    purpose:
      "Zwischenspeicher für Prüfungsantworten, damit bei Verbindungsabbruch oder Absturz nichts verloren geht. Getrennt je Browserfenster, damit ein übernommenes Fenster keine neueren Antworten überschreibt.",
    duration: "Bis die Antworten beim Server angekommen sind",
  },
  {
    names: ["openexam.examTabId"],
    kind: "sessionStorage",
    purpose:
      "Zufällige Kennung des Browserfensters, damit eine Prüfung nur in einem Fenster gleichzeitig bearbeitet wird.",
    duration: "Bis das Browserfenster geschlossen wird",
  },
  {
    names: [`${SUBMIT_KEY_PREFIX}:<Sitzung>`],
    kind: "localStorage",
    purpose: "Verhindert, dass eine Prüfung doppelt abgegeben wird.",
    duration: "Bis zur Löschung der Browserdaten",
  },
  {
    names: [PRE_EXAM_THEME_KEY, EXAM_TEXT_SIZE_KEY],
    kind: "localStorage",
    purpose:
      "Stellt nach der Prüfung die vorherige Darstellung (Farbschema, Schriftgrösse) wieder her.",
    duration: "Bis zum Ende der Prüfung",
  },
  {
    names: [TAB_ID_KEY],
    kind: "sessionStorage",
    purpose:
      "Erkennt, welcher Browser-Tab die Prüfung geöffnet hat, damit andere Tabs die Darstellung nicht verändern.",
    duration: "Bis der Tab geschlossen wird",
  },
  {
    names: [THEME_STORAGE_KEY],
    kind: "localStorage",
    purpose: "Speichert das gewählte Farbschema (hell/dunkel/System).",
    duration: "Bis zur Löschung der Browserdaten",
  },
  {
    names: [LAST_QUESTION_TYPE_KEY],
    kind: "localStorage",
    purpose:
      "Nur Lehrpersonen: merkt sich den zuletzt gewählten Fragetyp im Editor.",
    duration: "Bis zur Löschung der Browserdaten",
  },
]
