# SEB integration — out of scope

Design notes for the Safe Exam Browser integration (`lib/seb-key.ts`, `lib/seb-config.ts`,
`lib/seb-guard.ts`, `lib/seb-client.ts`, `ws-backend/internal/seb`). Read
this before extending or "fixing" the enforcement further.

## Browser Exam Key (BEK) / `X-SafeExamBrowser-RequestHash`

Implemented as a **per-session trust-on-first-use signal that never denies**
(`attestBrowserExamKey` in `lib/seb-guard.ts`, mirrored in `ws-backend/main.go`).

### What it actually is

`SafeExamBrowser.security.browserExamKey` is `sha256(pageURL + BEK)`, and the
BEK itself is an HMAC over SEB's settings:

- **macOS** — `HMAC(prefs, examKeySalt)` (`seb-mac SEBCryptor.m
  generateChecksumForBEK`). The binary is **not** part of it. It attests the
  config, not the program.
- **Windows** — additionally mixes in the executable's code-signing
  certificate hash and build version (`seb-win KeyGenerator.cs
  ComputeBrowserExamKey`), so there it does attest the build.

No SEB Server is required to observe or compare it.

### Two properties that shaped the design

**It is random per launch unless the config pins `examKeySalt`.** SEB mints a
fresh 32-byte salt whenever the loaded config carries none, so before
`Exam.sebExamKeySalt` existed, every launch produced a different BEK. A
pre-registered allowlist of approved keys therefore matched nothing and, being
fail-closed, would have denied **every student on every exam**. Verified on a
real macOS client. This is why the salt is a hard prerequisite, and why
regenerating or rotating it invalidates already-downloaded `.seb` files.

**It is client-supplied.** Like any value the client sends, it can be
reproduced by a client that is not SEB, so it cannot authenticate the client.

### Therefore: signal, not gate

Because it is forgeable, the guard only ever **binds it on first sight and
warns when it later changes** — it is never a reason to reject a request. The
flag reaches the invigilator live (Redis → the Go hub's monitor channel) and
the grader afterwards (`ExamSession.sebIntegrityFlaggedAt`).

What that buys over the existing Config Key binding: the Config Key token is
identical for every student of an exam, so it cannot notice one student
swapping client mid-exam. A BEK bound to *this* session can.

What it does **not** prove: TOFU detects *change*, not *approval*. A student
running a modified SEB from their very first request is trusted from then on.
A raised flag is a prompt for a human to look, not evidence of cheating.

### Do not

- Reintroduce a pre-registered per-exam allowlist. Per-student configs have
  now landed (see "Auto-login inside SEB" below): `startURL` carries a
  one-time login token, so the config differs per student and the BEK differs
  with it — one list cannot match a cohort.
- Branch policy on platform ("strict on Windows, lenient on macOS"). The
  client chooses its own `User-Agent`, so an attacker simply claims the
  lenient branch and the policy collapses to its weakest arm.
- **Read the BEK from `X-SafeExamBrowser-RequestHash`.** It carries
  `sha256(requestURL + BEK)`, so its value differs for every endpoint the
  client touches. Windows SEB sets it natively on every request, overwriting
  anything we put under that name. Binding it once and comparing it later
  therefore compares the take page's hash against `/api/sessions/*`'s and
  always disagrees, flagging every SEB session as `bek_changed`. The server
  reads only
  `x-openexam-seb-requesthash` (`SEB_BEK_HEADER`, set by `sebFetch` from the
  JS API's take-page value) and the WS handshake's `bekKey`, which are the
  same URL-independent value. This is the same trap the Config Key token fell
  into — see `identityToken` in `lib/seb-guard.ts`.
- Attest on a top-level navigation. Only `sebFetch` can set our header, so a
  navigation observes no BEK at all; reporting that absence would flag a
  student who merely reloaded the take page as `bek_disappeared`. The take
  page passes `isNavigation: true` to skip attestation entirely.

## Auto-login inside SEB (implemented — read before changing)

SEB opens its exam session with a cleared cookie jar
(`examSessionClearCookiesOnStart`), so nothing the student's normal browser
held carries over and they used to face a second login *inside* the
locked-down window — with no address bar to navigate back to the exam
afterwards. The handoff that removes it:

`launch-seb/page.tsx` mints a Better Auth one-time token alongside the launch
token and carries both on the `seb://` link. `seb-config/route.ts` bakes the
one-time token into `startURL` as `/exam/[id]/seb-enter?ott=…`, and that route
redeems it, forwards the `Set-Cookie` headers, and redirects to `/take`.

Three properties worth not breaking:

- **It degrades, never fails.** An expired, consumed or missing token just
  redirects to `/take` and the student logs in manually. A hard failure would
  strand them on an error page inside a browser with no way out.
- **The Config Key forks per student, and that is unavoidable.** `startURL` is
  part of the settings dict, and the whole dict is hashed. That is why the
  personalized key lives on `ExamSession.sebConfigKey` while
  `Exam.sebConfigKey` stays frozen as the *anonymous* key. `verifySebAccess`
  (and the Go handshake) accept a token matching either, which is what keeps
  teacher previews and pre-auto-login sessions working. The exam-level key
  must never be frozen from a personalized config — it is the one value every
  *other* student is compared against, so doing that denies the whole cohort.
- **Rotation clears `sebKeyHash`.** Every personalized fetch mints a fresh
  token and therefore a fresh key, so the previously bound hash is guaranteed
  stale and would lock the student out on the next relaunch. The guard's
  rebind path requires the new request to carry the User-Agent already on
  record, or re-downloading your own config from a normal browser would be a
  supported way to leave SEB mid-exam.

The one-time token is a full sign-in credential for the student, so it is
stored hashed (`storeToken: "hashed"`) and its TTL is pinned to
`LAUNCH_TOKEN_TTL_SECONDS`. Anyone who obtains a personalized `.seb` file
within that window can sign in as that student — which is why the window is
minutes, and why the download button's file is almost always already expired
by the time it is opened (it falls back to a manual login, as intended).

## SEB chrome is hidden (implemented — read before changing)

`buildSebSettings` sets `showTaskBar: false`, `showReloadButton: false`,
`enableBrowserWindowToolbar: false` and `hideBrowserWindowToolbar: true`, so SEB
draws no bar above or below the exam. `browserViewMode: 1` (fullscreen) is what
keeps Windows from drawing top chrome; the two toolbar keys are macOS-only and
ignored elsewhere.

This is not only cosmetic. SEB's chrome is the only clickable region on screen
that is not the exam, and every click on it moves focus out of the document
while the document stays perfectly visible — indistinguishable, to a `blur`
handler, from switching to another application. It was one of two sources of the
`WINDOW_BLUR` ("Fenster verlassen") false positives; `lib/blur-watch.ts` handles
the residue that hiding the bars cannot (SEB's own modal dialogs).

The bars can move focus out of the document while the exam stays visible.
On macOS, the covered/blurred native top bar can still take focus despite these
settings. The page's focus APIs cannot distinguish that from application
switching. After the usual 1.5-second confirmation, macOS SEB therefore reports
`PAGE_FOCUS_LOST` ("Prüfungsseite hat Fokus verloren (Hinweis)"). The monitor
keeps it in the event history and shows a neutral "Hinweise" count, separate
from `integrityEventCount`; it does not put the session in the attention queue.
A hidden document still reports `TAB_HIDDEN`. Other clients retain `WINDOW_BLUR`.
ws-backend persists at most 50 `PAGE_FOCUS_LOST` rows per session, separate
from the 200-row cap for the other kinds, so repeated top-bar clicks cannot
crowd out events that need review. Past either cap the live count keeps
growing, but the extra rows are not stored.
This trades the strength of visible app-switch detection on macOS SEB for an
accurate description of the observable signal. Existing events are unchanged.

On Windows, `enableAltTab: false` disables SEB's own task-view activator, which
otherwise takes focus even when `showTaskBar` is false. This is separate from
the native Windows Alt+Tab shortcut, which SEB's keyboard interceptor blocks.
See upstream [ShellOperation](https://github.com/SafeExamBrowser/seb-win-refactoring/blob/master/SafeExamBrowser.Client/Operations/ShellOperation.cs)
and [KeyboardInterceptor](https://github.com/SafeExamBrowser/seb-win-refactoring/blob/master/SafeExamBrowser.Monitoring/Keyboard/KeyboardInterceptor.cs).
Windows focus-loss detection stays enabled; the config prevents this particular
native control from taking focus in the first place.

Nothing load-bearing was removed. Reload keeps its hotkey, and quitting never
went through the task bar: the exit is `quitURL`, linked from the complete page,
which is what makes handing in the only way out.

What the bar *did* legitimately provide is rebuilt in the page instead, by
`components/exam-taking/exam-system-status.tsx` (rendered only inside SEB, since
a normal browser still has the OS's own):

- **Clock.** Server-corrected, off the same 1s ticker the exam timer runs.
- **Battery.** `navigator.getBattery()`, at SEB's own low/critical thresholds.
  Chromium-only, so it appears on Windows SEB and is silently absent on macOS's
  WKWebView — see `describeBattery`, which returns null rather than a red 0%.
- **Connection.** The Wi-Fi control could not be rebuilt — no browser API
  reaches the network stack — but its informational half is: an "Offline" badge
  after the socket has been down for 5s, long enough that a routine reconnect
  does not flash a warning at a student mid-exam.

Not rebuilt: the input-language indicator (the page cannot read the OS keyboard
layout) and the on-screen-keyboard toggle. `oskBehavior` is left at SEB's
default, so whatever the client does on focus in a text field is unchanged; only
the manual toggle button went with the bar.

**Any change here re-freezes the Config Key.** These keys are part of the
settings dict, so every `.seb` file issued before the change stops matching —
run `pnpm seb:regenerate-keys` and have students download their config again.
Deploy the additive `PAGE_FOCUS_LOST` enum migration before the updated web and
WebSocket services. The Windows Alt+Tab setting changes the Config Key: schedule
the rollout between exams, regenerate keys, and have students relaunch with fresh
configs. Already-open SEB clients keep the settings they launched with; changing
the server cannot disable their task view mid-session.
Deploy ws-backend no later than the web app: an older ws-backend drops the
unknown `PAGE_FOCUS_LOST` kind, so macOS SEB focus loss reported in between is
lost rather than recorded.

On a real Windows device, check that a window opened from the exam (a file
download from an upload question uses `window.open`) can still be closed to
return to the exam: with the task bar hidden and Alt+Tab disabled, closing it
is the only way back.

Neither production image can run that command as written — see the header of
`scripts/regenerate-seb-config-keys.ts` for the invocation that works there.

## What the session binding does and does not prove

`ExamSession.sebKeyHash` / `sebUserAgent` (bound on first SEB-validated
request, checked on every one after) catch a session that starts in SEB and
later switches to a plain browser — the User-Agent stops matching. They do
**not** prove the request came from the enrolled student, or even from SEB
at all beyond the first check: the User-Agent header is fully
client-controlled and trivially spoofable. Treat this as a tripwire for
accidental or lazy exits from SEB, not as identity or device attestation.

## Quitting (implemented — read before changing)

`allowQuit` is true but `hashedQuitPassword` is set (`Exam.sebQuitPassword`,
surfaced to the teacher on the live monitor as an emergency override). So the
quit button, ⌘Q and the exit keys all prompt for a password students don't
have. Their only exit is `quitURL` — which SEB honours *without* a password —
and the only link to it is the "Safe Exam Browser beenden" button on the
complete page. Net effect, and the reason it's built this way: SEB cannot be
left until the exam has been handed in.

Two constraints that are easy to break by accident:

- **`quitURL` must stay a dedicated route** (`/exam/[id]/quit`) that nothing
  else navigates or redirects to. SEB quits the instant it *loads* that URL. It
  used to point at `/complete`, which `take/page.tsx` redirects to whenever an
  exam isn't ACTIVE — that would have slammed SEB shut on a student opening an
  exam early.
- **The link to it must be a plain `<a>`, not `next/link`.** SEB matches the
  quit URL on a real page load; `next/link` soft-navigates via `pushState`,
  which SEB does not see.

The password feeds the Config Key, so it must never be regenerated for an exam
whose `.seb` file is already out in the wild — hence the conditional write in
`ensureSebQuitPassword` (`lib/seb-secrets.ts`) rather than a plain update.

### Quit-password strength (16 chars, encrypted at rest)

The quit password is the only gate between the student and a silent mid-exam
SEB exit (`allowQuit: true` + `hashedQuitPassword`). Its *hash* ships inside
the `.seb` file every student legitimately downloads — SEB's config format
only accepts the unsalted SHA-256 hex — so a student holding their own config
can crack the password offline. `generateQuitPassword` therefore defaults to
**16 characters** (32-char alphabet, ~2^80): far beyond any practical offline
effort while still typable off a screen. It is also stored **AES-256-GCM
encrypted at rest** (`lib/at-rest-encryption.ts`) so a database dump does not
hand it out verbatim; existing plaintext rows are re-encrypted by
`scripts/encrypt-at-rest.ts`.

## macOS lockdown mode (SEB 3.7 — implemented, read before changing)

`buildSebSettings` pins `lockdownModePolicy: 0` (Automatic), `minMacOSVersion:
11` (= `SEBMinMacOS13`), `allowOpenAndSavePanel: true` and
`detectAccessibilityApps: true`. Three things about that set:

- **The keys are one decision, not four.** SEB force-sets
  `allowOpenAndSavePanel` to true only for configs carrying *no*
  `lockdownModePolicy` key (`migrateLockdownModePolicyFromLoadedSettings:`
  returns early otherwise). Pinning the policy opts out of that migration, so
  dropping `allowOpenAndSavePanel` would leave AAC's file dialog shut and
  FILE_UPLOAD questions unanswerable, with `allowUploads: true` still set.
- **`minMacOSVersion` is what buys the stronger lockdown**, not the policy.
  SEB's own test is `minMacOSVersion > SEBMinMacOS12`, so 13 is the lowest
  value under which AAC cannot quietly fall back to Classic kiosk mode. It also
  refuses students on macOS 11/12 — a deliberate trade, and the first thing to
  revisit if a cohort cannot sit an exam.
- **`lockdownModePolicyEnforceAAC` (2) is not the stronger choice.** On a Mac
  too old for AAC it disables AAC at runtime with no Classic fallback, which is
  less lockdown than before, not more.

Each of these changes the Config Key. `Exam.sebConfigKey` is written set-once
(the activate and seb-config routes) and `verifySebAccess` compares against it,
so deploying a `buildSebSettings` change while an exam is ACTIVE denies every
student holding an earlier `.seb` file. `scripts/regenerate-seb-config-keys.ts`
re-keys SEB exams after such a change (between exam windows — it must include
the pinned `examKeySalt`, or the keys it writes match no student token and the
fail-closed guard denies the whole cohort).

## Config Key string compatibility

`lib/seb-key.ts` follows the legacy string serialization retained by
[macOS 43ba8c54](https://github.com/SafeExamBrowser/seb-mac/blob/43ba8c54/Classes/Cryptography/SEBCryptor.m)
and [Windows 016d2341](https://github.com/SafeExamBrowser/seb-win-refactoring/blob/016d2341/SafeExamBrowser.Configuration/ConfigurationData/Json.cs):
string keys and values are wrapped in quotes without escaping quotes,
backslashes or control characters. These bytes are hashed, not parsed as JSON.
Both clients reject a double quote followed by optional whitespace and a comma
in keys or values, including nested settings, to prevent serialization collisions.
OpenExam rejects that sequence before hashing as well.

`testdata/seb-config-key-strings.json` pins accepted string bytes and independent
SHA-256 digests. This verifies string compatibility against the referenced
source; it does not replace testing `.seb` files on installed clients.
Ordinary generated settings keep their keys. If an existing frozen config
contains quotes or control characters, correcting its serialization changes
its key: regenerate frozen keys and redistribute the configs before an exam.
Do not rotate keys during an active exam.

## Minimum SEB client version (SEB 3.7.1 `sebAllowedVersions` — implemented, read before changing)

macOS SEB 3.7.1 added "Allowed SEB Versions": one or more `OS.Major.Minor[.Patch]
[.Build][.AE][.min]` restriction strings baked into the settings dict. SEB
checks its own build against the restrictions before starting the exam. On
current clients, a platform with no entry is unrestricted. When entries exist
for the running platform, at least one must match; otherwise SEB shows an alert
and quits. This is client-side defense in depth, not server-side attestation:
older clients can ignore the setting and a modified client can omit the check.
See the [upstream release notes](https://safeexambrowser.org/macosx/mac_release_notes_en.html).

**Why this matters:** the macOS lockdown posture this file documents above
already assumes SEB 3.7+ (`lockdownModePolicy`, `minMacOSVersion`,
`detectAccessibilityApps` are all 3.7 features an older client silently
ignores, falling back to weaker or default kiosk behavior with no signal to
either side that it did). Nothing previously stopped a student from
launching such an older build, and `sebAllowedVersions` does not fully close
that gap either — see the limitation below before assuming it does.

**Why it defaults to unset (`sebAllowedVersionsFromEnv` in
`lib/seb-config.ts`) instead of a hardcoded floor:** operators must qualify
client releases on the devices their students use before requiring them.
The earlier beta-only rationale is obsolete: macOS SEB 3.7.1 has been released.
Its client-side restriction still cannot exclude older clients that ignore
this setting. Include an entry for each platform you intend to constrain;
omitting iOS, for example, leaves iOS unrestricted rather than blocking iPads.

### Do not

- **Assume this excludes clients older than the configured floor.**
  `sebAllowedVersions` is itself a SEB 3.7.1 feature, so it only enforces a
  floor among clients that already understand it.
- Assume that restricting one platform restricts the others. Omitted platforms
  remain unrestricted. Qualify required releases on real clients for each
  platform you constrain before changing `SEB_ALLOWED_VERSIONS`.
- Treat this as a replacement for `verifySebAccess`'s server-side checks. It
  denies the launch at the client, before any request reaches this server —
  useful defense in depth, but a request that does arrive still goes through
  the same fail-closed Config Key/UA checks as before.
- Forget it's part of the settings dict: turning it on for the first time,
  or editing the list, changes `Exam.sebConfigKey` like any other
  `buildSebSettings` key (see "Frozen Config Key" below) and needs
  `pnpm seb:regenerate-keys` between exam windows, not while one is ACTIVE.

## Frozen Config Key (implemented — read before changing)

`Exam.sebConfigKey` freezes on first write (activation or first `.seb`
download). After that, the fields baked into the settings dict must not change:
`SEB_LOCKED_FIELDS` in `lib/seb-config.ts` enumerates them, and
`PATCH /api/exams/[id]` rejects any patch touching one of them with a 409 while
the key is frozen. Extend the list whenever a new key lands in
`buildSebSettings` — a field that drifts without being locked produces a cohort
where new configs carry a key the guard will never accept.

## Manual SEB-client verification

Automated coverage proves the file format, Config Key canonicalization and
the guard's fail-closed behavior:

- `__tests__/seb.test.ts` — file-format round-trip (`gunzip → "plnd" +
  gunzip → parseable plist`), Config Key canonicalization, URL filter
  content.
- `__tests__/seb-guard.test.ts` — `verifySebAccess` fail-closed table tests.
- `ws-backend/internal/seb/seb_test.go` — cross-language fixture asserting
  Go's `ExpectedToken` matches TypeScript's `configKeyTokenForUrl` for the
  same inputs.

None of these substitute for launching the exam in a real SEB client on each
platform you support before the first graded use. Check in particular:

- that the quit button/⌘Q prompt for the password, and that the quit URL
  exits without one;
- that a 3.7 client enters AAC with these settings (its log line is
  `Using lockdownModePolicyAutomatic: AAC enabled`) and that a FILE_UPLOAD
  question still opens a file dialog under it;
- that `detectAccessibilityApps` fires. It needs Full Disk Access on the
  student's Mac, so it belongs in the invigilation instructions, not only in
  the config.
