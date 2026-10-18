import plist from "plist"
import { gzipSync } from "zlib"
import { createHash, randomBytes } from "node:crypto"
import { computeConfigKey } from "@/lib/seb-key"

export interface SebExamInput {
  id: string
  allowSpellCheck?: boolean
  /**
   * Plaintext emergency-override password. Hashed into `hashedQuitPassword`,
   * which gates the quit button, ⌘Q and the exit keys. Students never see it;
   * their exit is the quit URL, which SEB honours without a password.
   */
  quitPassword?: string | null
  /**
   * This exam's pinned 32-byte `examKeySalt` (Exam.sebExamKeySalt). Omit and
   * SEB generates a random one per launch, making the Browser Exam Key differ
   * on every launch — see generateExamKeySalt below and the schema comment.
   */
  examKeySalt?: Buffer | null
  /**
   * One-time login token handed to SEB's cookieless first request by routing
   * `startURL` through app/exam/[id]/seb-enter/route.ts, which redeems it and
   * forwards the resulting session cookie. Without it a student has to log in
   * a second time inside the locked-down browser.
   *
   * startURL is part of the settings dict, so supplying this necessarily
   * changes the Config Key — the resulting key is per-student and belongs on
   * ExamSession.sebConfigKey, not Exam.sebConfigKey. Omit for the anonymous
   * config (teacher previews, and the frozen exam-level key).
   */
  loginToken?: string | null
}

/** SEB's own salt length: RNCryptor randomDataOfLength:kCCKeySizeAES256. */
export const EXAM_KEY_SALT_BYTES = 32

export function generateExamKeySalt(): Buffer {
  return randomBytes(EXAM_KEY_SALT_BYTES)
}

// No I/O/0/1 — this gets read off a screen and typed into SEB by hand.
const QUIT_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/**
 * 32-character alphabet divides 256 evenly, so a plain modulo introduces no
 * bias. Keep the length at 16 or more; it is a security parameter.
 */
export function generateQuitPassword(length = 16): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) {
    out += QUIT_PASSWORD_ALPHABET[bytes[i] % QUIT_PASSWORD_ALPHABET.length]
  }
  return out
}

/** SEB stores quit/admin passwords as the lowercase hex SHA256 of the UTF-8 password. */
export function hashQuitPassword(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("hex")
}

/**
 * Client version floor (SEB's `sebAllowedVersions`), read from
 * SEB_ALLOWED_VERSIONS. Empty by default (no restriction).
 *
 * macOS SEB 3.7.1 added support for this key. Clients predating support
 * ignore it and launch anyway, so it cannot exclude all outdated clients.
 * See "Minimum SEB client version" in SEB_OUT_OF_SCOPE.md.
 *
 * Current SEB clients restrict only platforms named in the list. A platform
 * with no entry remains unrestricted; include every platform whose version
 * this deployment intends to constrain.
 *
 * Format: one `OS.Major.Minor[.Patch][.Build][.AE][.min]` string per entry,
 * e.g. `Mac.3.7.1.min` or `Win.3.10.2.min`.
 */
export function sebAllowedVersionsFromEnv(
  env: Record<string, string | undefined> = process.env
): string[] {
  const raw = env.SEB_ALLOWED_VERSIONS
  if (!raw) return []
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * Exam fields that feed the SEB settings dict. Once `Exam.sebConfigKey` is
 * frozen they must not change, or every distributed config stops matching
 * the persisted key and the whole cohort is denied. `sebRequired` is not in
 * the dict but is locked for the same reason.
 *
 * Extend this list whenever a new setting is added to `buildSebSettings`.
 */
export const SEB_LOCKED_FIELDS = ["sebRequired", "allowSpellCheck"] as const

/**
 * Returns the name of the first SEB-locked field whose value would change,
 * or null when the patch is allowed. Re-sending the persisted value is a
 * no-op, even after the Config Key is frozen. The patch may change anything
 * else — titles, schedules, question shuffling — without invalidating the
 * frozen Config Key; only the fields above are part of the settings dict.
 */
export function sebSettingsLockViolation(
  exam: {
    sebConfigKey: string | null
    sebRequired?: boolean
    allowSpellCheck?: boolean
  },
  patch: Record<string, unknown>
): string | null {
  if (!exam.sebConfigKey) return null
  for (const field of SEB_LOCKED_FIELDS) {
    if (field in patch && patch[field] !== exam[field]) return field
  }
  return null
}

/**
 * The single source of truth for an exam's SEB settings dict. Both the
 * distributed .seb file and the Config Key are derived from this same
 * object, so they can never drift apart.
 *
 * Several keys here restate what is already SEB's default. That is deliberate:
 * the defaults were verified against seb-mac, and SEB for Windows is a separate
 * codebase, so spelling the lockdown out keeps the posture identical on both
 * platforms rather than resting on an unverified cross-platform assumption.
 */
export function buildSebSettings(
  exam: SebExamInput,
  baseUrl: string,
  env: Record<string, string | undefined> = process.env
): plist.PlistObject {
  const { protocol, host } = new URL(baseUrl)
  const allowedVersions = sebAllowedVersionsFromEnv(env)
  const lockdownHardening: Record<string, boolean | number> = {
    enablePrivateClipboardMacEnforce: true,
    allowScreenCapture: false,
    allowWindowCapture: false,
    screenSharingMacEnforceBlocked: true,
    blockScreenShotsLegacy: true,
    enablePrintScreen: false,
    allowedDisplaysMaxNumber: 1,
    allowedDisplayBuiltinEnforce: true,
    allowDisplayMirroring: false,
    allowSiri: false,
    allowDictation: false,
    allowDictionaryLookup: false,
    // Windows SEB's own Alt+Tab task view takes focus from the exam even
    // with the taskbar hidden. Disable its activator to avoid false blur
    // reports. The native Windows Alt+Tab shortcut is intercepted by SEB.
    enableAltTab: false,
    enableAltEsc: false,
    enableCtrlEsc: false,
    enableStartMenu: false,
    insideSebEnableStartTaskManager: false,
    insideSebEnableChangeAPassword: false,
    insideSebEnableLockThisComputer: false,
    insideSebEnableLogOff: false,
    insideSebEnableSwitchUser: false,
    insideSebEnableShutDown: false,
    insideSebEnableEaseOfAccess: false,
    insideSebEnableVmWareClientShade: false,
    sebServicePolicy: 2,
    autoQuitApplications: true,
    removeBrowserProfile: true,
    useTemporaryDownUploadDirectory: true,
    newBrowserWindowByLinkBlockForeign: true,
    browserWindowAllowAddressBar: false,
    newBrowserWindowAllowAddressBar: false,
  }
  return {
    // Routed through /seb-enter only with a login token, so the anonymous
    // startURL (and the frozen Exam.sebConfigKey) stays unchanged.
    startURL: exam.loginToken
      ? `${baseUrl}/exam/${exam.id}/seb-enter?ott=${encodeURIComponent(exam.loginToken)}`
      : `${baseUrl}/exam/${exam.id}/take`,
    sendBrowserExamKey: true,
    sebConfigPurpose: 0,

    // Optional keys below are omitted rather than emitted empty: an empty
    // value hashes differently from an absent key and would change the
    // Config Key of existing exams.
    ...(allowedVersions.length ? { sebAllowedVersions: allowedVersions } : {}),

    // Pins the salt so the Browser Exam Key is stable across launches.
    ...(exam.examKeySalt ? { examKeySalt: exam.examKeySalt } : {}),

    // Quitting is password-gated; students leave via the quit URL, which is
    // linked only from the complete page. Keep it a dedicated route: SEB quits
    // as soon as it loads it.
    allowQuit: true,
    quitURL: `${baseUrl}/exam/${exam.id}/quit`,
    quitURLConfirm: false,

    // --- macOS lockdown mode (SEB 3.7) ---
    //
    // 0 = Automatic: AAC where supported, Classic kiosk otherwise. Do not use
    // 2 (EnforceAAC); minMacOSVersion below is what guarantees AAC.
    lockdownModePolicy: 0,

    // Required under AAC for FILE_UPLOAD questions. Must always be set
    // together with lockdownModePolicy.
    allowOpenAndSavePanel: true,

    // 11 = SEBMinMacOS13, the lowest value that guarantees AAC.
    minMacOSVersion: 11,

    // Terminates apps holding macOS Accessibility permissions. Already SEB's
    // default; stated explicitly in case the default changes. Needs Full Disk
    // Access on the student's Mac; without it the detection does not run.
    detectAccessibilityApps: true,

    browserViewMode: 1,
    // 3 = force modern WebView. On macOS the token then comes only from the
    // JS API (lib/seb-client.ts), not the native header.
    browserWindowWebView: 3,

    enablePrivateClipboard: true,
    allowSpellCheck: exam.allowSpellCheck ?? false,
    allowBrowsingBackForward: false,
    allowDeveloperConsole: false,
    allowVirtualMachine: false,
    allowScreenSharing: false,
    ...lockdownHardening,

    // allowUploads defaults to NO in SEB — without this the file picker never
    // opens and FILE_UPLOAD questions cannot be answered. (allowDownloads and
    // allowDownUploads already default to YES.)
    allowUploads: true,

    // Classic WebView is required for SafeExamBrowser.security.updateKeys (the
    // JS Config Key API) to be available, and the content filter forces the
    // classic WebView off — which would break the macOS enforcement path.
    URLFilterEnable: true,
    URLFilterEnableContentFilter: false,
    URLFilterRules: [
      // URLFilterEnable already denies by default; do not add a catch-all
      // block rule (SEB checks block rules first). The scheme is required, or
      // SEB parses `localhost:3000` as a scheme and the rule matches nothing.
      {
        active: true,
        action: 1,
        expression: `${protocol}//${host}/*`,
        regex: false,
      },
    ],

    examSessionClearCookiesOnStart: true,
    examSessionClearCookiesOnEnd: true,

    // SEB's own chrome is hidden: clicks on it cause false "Fenster verlassen"
    // integrity events (see BLUR_CONFIRM_MS in hooks/use-integrity-monitor.ts).
    showTaskBar: false,
    showReloadButton: false,
    // F5 still reloads (browserWindowAllowReload stays at SEB's default YES;
    // answers survive a reload), but without SEB's native "reload this
    // page?" dialog. That dialog takes focus from the page, so every
    // deliberate reload was reported as "Fenster verlassen" (observed in the
    // Windows SEB Probeprüfung on 2026-10-12).
    showReloadWarning: false,

    // macOS only; both keys are needed. Windows ignores them.
    enableBrowserWindowToolbar: false,
    hideBrowserWindowToolbar: true,

    ...(exam.quitPassword
      ? { hashedQuitPassword: hashQuitPassword(exam.quitPassword) }
      : {}),
  }
}

export interface GeneratedSebConfig {
  file: Buffer
  configKey: string
}

/**
 * Builds the .seb file per the file-format spec
 * (https://safeexambrowser.org/developer/seb-file-format.html):
 * gzip(plist) -> prefix "plnd" -> gzip again. A single outer gzip (the
 * previous implementation) is not a file SEB can open.
 */
export function generateSebConfig(
  exam: SebExamInput,
  baseUrl: string
): GeneratedSebConfig {
  const settings = buildSebSettings(exam, baseUrl)
  // Per SEB's own Config Key spec (safeexambrowser.org/developer/seb-config-key.html):
  // "The SEB client only uses setting key/values to calculate the checksum,
  // which are actually contained in an opened config file" — whereas
  // "the exam system uses all key/values it generates". Since we generate
  // every key in `settings` (the .seb file's full contents), those two are
  // the same set here: hash exactly the override dict, not SEB's internal
  // defaults merged in.
  const configKey = computeConfigKey(settings)

  const xml = plist.build(settings)
  const innerGz = gzipSync(Buffer.from(xml, "utf8"))
  const prefixed = Buffer.concat([Buffer.from("plnd"), innerGz])
  const file = gzipSync(prefixed)

  return { file, configKey }
}
