import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"
import plist from "plist"
import stringFixtures from "@/testdata/seb-config-key-strings.json"
import { describe, expect, it } from "vitest"
import { computeConfigKey, configKeyTokenForUrl } from "@/lib/seb-key"
import {
  generateSebConfig,
  buildSebSettings,
  generateQuitPassword,
  sebAllowedVersionsFromEnv,
} from "@/lib/seb-config"

describe("computeConfigKey", () => {
  it("matches a known fixture computed independently from the same canonicalization rules", () => {
    // Canonical form: keys sorted case-insensitively, no whitespace:
    // {"a":1,"b":{"c":true,"d":"x"}}
    const fixtureCanonical = '{"a":1,"b":{"c":true,"d":"x"}}'
    const expected = createHash("sha256")
      .update(fixtureCanonical, "utf8")
      .digest("hex")
    expect(computeConfigKey({ b: { d: "x", c: true }, a: 1 })).toBe(expected)
  })

  it("is deterministic and order-independent at every nesting level", () => {
    const a = computeConfigKey({ z: 1, a: { y: 2, x: 3 } })
    const b = computeConfigKey({ a: { x: 3, y: 2 }, z: 1 })
    expect(a).toBe(b)
  })

  it("sorts keys case-insensitively (not ordinal, where 'B' < 'a')", () => {
    // Ordinal (case-sensitive) sort would put "Banana" before "apple" since
    // 'B' (0x42) < 'a' (0x61); the spec requires comparing lowercased keys,
    // which puts "apple" first.
    const caseInsensitiveOrder = createHash("sha256")
      .update('{"apple":2,"Banana":1}', "utf8")
      .digest("hex")
    expect(computeConfigKey({ Banana: 1, apple: 2 })).toBe(caseInsensitiveOrder)
    expect(computeConfigKey({ apple: 2, Banana: 1 })).toBe(caseInsensitiveOrder)
  })

  it("serializes binary values as their base64 string, per SEB's jsonStringForObject", () => {
    // seb-mac SEBCryptor.m: NSData -> "\"%@\"" of base64EncodedStringWithOptions:0.
    // A Buffer must therefore hash identically to a string holding that base64 —
    // NOT as a dict of byte indices, which is what the isPlainObject branch
    // would produce and what would silently desync us from SEB.
    const salt = Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
    const asBase64String = computeConfigKey({
      examKeySalt: salt.toString("base64"),
    })
    expect(computeConfigKey({ examKeySalt: salt })).toBe(asBase64String)
  })

  it('serializes empty binary as "", not as base64 of nothing', () => {
    // Same source: `if ([object isEqualToData:[NSData data]]) jsonString = @"\"\""`.
    const expected = createHash("sha256")
      .update('{"examKeySalt":""}', "utf8")
      .digest("hex")
    expect(computeConfigKey({ examKeySalt: Buffer.alloc(0) })).toBe(expected)
  })

  it("changes the Config Key when the salt changes", () => {
    // The salt is hashed like any other setting (SEB removes only
    // originatorVersion), so rotating it invalidates already-issued configs.
    const a = computeConfigKey({
      startURL: "u",
      examKeySalt: Buffer.alloc(32, 1),
    })
    const b = computeConfigKey({
      startURL: "u",
      examKeySalt: Buffer.alloc(32, 2),
    })
    expect(a).not.toBe(b)
  })

  it("drops originatorVersion", () => {
    const withVersion = computeConfigKey({
      originatorVersion: "OpenExam 1.0",
      a: 1,
    })
    const withoutVersion = computeConfigKey({ a: 1 })
    expect(withVersion).toBe(withoutVersion)
  })

  it("drops empty dicts, recursively", () => {
    const withEmpty = computeConfigKey({ a: 1, b: {} })
    const withoutEmpty = computeConfigKey({ a: 1 })
    expect(withEmpty).toBe(withoutEmpty)

    const withNestedEmpty = computeConfigKey({ a: 1, b: { c: {} } })
    expect(withNestedEmpty).toBe(withoutEmpty)
  })

  it("serializes booleans as bare true/false and integers without a decimal point", () => {
    const key = computeConfigKey({ flag: true, off: false, n: 40 })
    const expected = createHash("sha256")
      .update('{"flag":true,"n":40,"off":false}', "utf8")
      .digest("hex")
    expect(key).toBe(expected)
  })

  it("keeps the fractional part of a plist <real> instead of rounding it away", () => {
    // The whole point of a real: 2.7 and 3 are different settings, and rounding
    // (what this used to do) made them hash identically while SEB hashes them
    // apart — a Config Key mismatch, which denies every student on the exam.
    const key = computeConfigKey({ n: 2.7 })
    const expected = createHash("sha256")
      .update('{"n":2.7}', "utf8")
      .digest("hex")
    expect(key).toBe(expected)
    expect(key).not.toBe(computeConfigKey({ n: 3 }))
  })

  it("rounds a float to the shortest decimal that round-trips, per the spec's 0.1 example", () => {
    // The spec's own example: <real>0.10000000000000001</real> hashes as 0.1.
    expect(computeConfigKey({ n: 0.10000000000000001 })).toBe(
      createHash("sha256").update('{"n":0.1}', "utf8").digest("hex")
    )
  })

  it("refuses numbers with no SEB representation rather than hashing a guess", () => {
    expect(() => computeConfigKey({ n: NaN })).toThrow(/non-finite/)
    expect(() => computeConfigKey({ n: Infinity })).toThrow(/non-finite/)
    expect(() => computeConfigKey({ n: 1e21 })).toThrow(/exponent/)
  })

  it("does not escape backslashes, unlike JSON.stringify", () => {
    const key = computeConfigKey({ path: "C:\\Windows" })
    // JSON.stringify would double the backslash to \\\\; the SEB canonical
    // form leaves it as a single backslash.
    const expected = createHash("sha256")
      .update('{"path":"C:\\Windows"}', "utf8")
      .digest("hex")
    expect(key).toBe(expected)
    expect(key).not.toBe(
      createHash("sha256")
        .update(JSON.stringify({ path: "C:\\Windows" }), "utf8")
        .digest("hex")
    )
  })

  it.each(stringFixtures.vectors)(
    "matches upstream string serialization: $name",
    ({ settings, canonical, configKey }) => {
      expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(
        configKey
      )
      expect(computeConfigKey(settings)).toBe(configKey)
    }
  )

  it.each([
    '",',
    '" ,',
    '"\n,',
    '"\t,',
    '"\r,',
    '"\u0085,',
    '"\u00a0,',
    '"\u2028,',
  ])("rejects a quote/comma sequence in settings: %j", (sequence) => {
    const injection = `${sequence}"hashedQuitPassword":"changed`
    for (const settings of [
      { s: injection },
      { [injection]: "value" },
      { a: [{ s: injection }] },
      { a: [{ [injection]: "value" }] },
      { a: [injection] },
    ]) {
      expect(() => computeConfigKey(settings)).toThrow(/quote.*comma/)
    }
  })

  it("serializes arrays element-wise and null as null", () => {
    const expected = createHash("sha256")
      .update('{"l":[1,"x",true,{"k":null}]}', "utf8")
      .digest("hex")
    expect(computeConfigKey({ l: [1, "x", true, { k: null }] } as never)).toBe(
      expected
    )
  })

  it("refuses value types with no plist representation", () => {
    expect(() =>
      computeConfigKey({ f: (() => 1) as unknown as string })
    ).toThrow(/unsupported value type function/)
  })

  it("produces no whitespace in the canonical form", () => {
    const spaced = createHash("sha256")
      .update('{"a": 1, "b": 2}', "utf8")
      .digest("hex")
    const compact = computeConfigKey({ a: 1, b: 2 })
    expect(compact).not.toBe(spaced)
    expect(compact).toBe(
      createHash("sha256").update('{"a":1,"b":2}', "utf8").digest("hex")
    )
  })
})

describe("configKeyTokenForUrl", () => {
  // Shared with ws-backend/internal/seb/seb_test.go's TestExpectedToken_*.
  // Go's ExpectedToken must produce the exact same hex string as this
  // function for the two sides to ever agree on a request.
  it("matches the fixture asserted by the Go implementation (internal/seb.ExpectedToken)", () => {
    const takeUrl = "http://localhost:3000/exam/exam1/take"
    const fixtureConfigKey = "fixture-config-key-123"
    const fixtureToken =
      "31dbc8371cd20d4a0606f137a0027bcc797574e2b4ed79462b1d74e44b47fab5"
    expect(configKeyTokenForUrl(takeUrl, fixtureConfigKey)).toBe(fixtureToken)
  })
})

describe("generateSebConfig .seb file format", () => {
  const baseUrl = "https://exam.school.ch"

  it("computes the Config Key from the same settings object the file is built from", () => {
    // Per SEB's Config Key spec: the client hashes only the keys "actually
    // contained in an opened config file", while a server hashes "all
    // key/values it generates" — the same set here, since `settings` is the
    // .seb file's entire contents.
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    const { configKey: fromSettings } = generateSebConfig(
      { id: "exam1" },
      baseUrl
    )
    expect(fromSettings).toBe(computeConfigKey(settings))
  })

  it("round-trips: gunzip -> 'plnd' prefix + gunzip -> parseable plist (per the file-format spec)", () => {
    const { file } = generateSebConfig({ id: "exam1" }, baseUrl)

    const outerDecompressed = gunzipSync(file)
    expect(outerDecompressed.subarray(0, 4).toString("utf8")).toBe("plnd")

    const innerGzipped = outerDecompressed.subarray(4)
    const xml = gunzipSync(innerGzipped).toString("utf8")

    const parsed = plist.parse(xml) as Record<string, unknown>
    expect(parsed.startURL).toBe("https://exam.school.ch/exam/exam1/take")
  })

  it("hides SEB's own chrome, top and bottom, on both platforms", () => {
    // Every pixel of SEB chrome is somewhere a student can click that is not the
    // exam, and each such click blurs the document while it stays visible —
    // the shape of the "Fenster verlassen" false positives seen in production.
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)

    expect(settings.showTaskBar).toBe(false)
    expect(settings.showReloadButton).toBe(false)
    // macOS toolbar: both keys are needed — one decides whether it exists, the
    // other whether it is drawn.
    expect(settings.enableBrowserWindowToolbar).toBe(false)
    expect(settings.hideBrowserWindowToolbar).toBe(true)
    // Fullscreen, which is what keeps Windows from drawing top chrome at all.
    expect(settings.browserViewMode).toBe(1)
  })

  it("reloads on F5 without SEB's focus-stealing confirmation dialog", () => {
    // The dialog is native SEB UI: while it is open the page has lost focus,
    // so each deliberate reload surfaced as "Fenster verlassen".
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)

    expect(settings.showReloadWarning).toBe(false)
    // Reload itself stays available (SEB's default) as the recovery path.
    expect(settings).not.toHaveProperty("browserWindowAllowReload")
  })

  it("still lets the student out: quitting never went through the task bar", () => {
    // Hiding the task bar removes SEB's quit button. The exit is the quit URL,
    // linked from the complete page, which SEB honours without the password —
    // so handing in remains the only way out, exactly as before.
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(settings.allowQuit).toBe(true)
    expect(settings.quitURL).toBe(`${baseUrl}/exam/exam1/quit`)
  })

  it("omits examKeySalt entirely when no salt is given", () => {
    // Not "emits empty data": the salt is hashed into the Config Key, so an
    // empty <data> would still shift the key and invalidate every config
    // generated before this field existed.
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect("examKeySalt" in settings).toBe(false)
  })

  it("embeds the pinned examKeySalt when one is given", () => {
    const salt = Buffer.alloc(32, 7)
    const settings = buildSebSettings(
      { id: "exam1", examKeySalt: salt },
      baseUrl
    )
    expect(settings.examKeySalt).toEqual(salt)
  })

  it("a pinned salt is what makes two downloads of the same config identical", () => {
    // The whole point: without it SEB mints a random salt per launch and the
    // Browser Exam Key differs every time (SEBCryptor.m generateExamKeySalt),
    // so it cannot be bound to a session.
    const salt = Buffer.alloc(32, 3)
    const a = generateSebConfig({ id: "exam1", examKeySalt: salt }, baseUrl)
    const b = generateSebConfig({ id: "exam1", examKeySalt: salt }, baseUrl)
    expect(a.configKey).toBe(b.configKey)

    const other = generateSebConfig(
      { id: "exam1", examKeySalt: Buffer.alloc(32, 4) },
      baseUrl
    )
    expect(other.configKey).not.toBe(a.configKey)
  })

  it("activation and download agree on the Config Key when both pass the same salt", () => {
    // The lockout this guards against: activate/route.ts persists
    // Exam.sebConfigKey and verifySebAccess compares every student's token
    // against that one value. If the download salted its config while
    // activation did not, the two keys differ and the exam denies everyone.
    const salt = Buffer.alloc(32, 9)
    const atActivation = generateSebConfig(
      {
        id: "exam1",
        allowSpellCheck: false,
        quitPassword: "QUITPASS12",
        examKeySalt: salt,
      },
      baseUrl
    ).configKey
    const atDownload = generateSebConfig(
      {
        id: "exam1",
        allowSpellCheck: false,
        quitPassword: "QUITPASS12",
        examKeySalt: salt,
      },
      baseUrl
    ).configKey
    expect(atDownload).toBe(atActivation)

    // ...and that a salt on only one side is exactly what breaks it.
    const unsalted = generateSebConfig(
      { id: "exam1", allowSpellCheck: false, quitPassword: "QUITPASS12" },
      baseUrl
    ).configKey
    expect(unsalted).not.toBe(atActivation)
  })

  it("a null salt generates the same config as passing none at all", () => {
    // ensureSebExamKeySalt returns null for exams whose key predates the
    // field; that must be byte-identical to the pre-change behaviour.
    const withNull = generateSebConfig(
      { id: "exam1", examKeySalt: null },
      baseUrl
    )
    const without = generateSebConfig({ id: "exam1" }, baseUrl)
    expect(withNull.configKey).toBe(without.configKey)
  })

  it("does not include a catch-all block rule, which would discard every request", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    const rules = settings.URLFilterRules as {
      action: number
      expression: string
    }[]
    expect(rules.some((r) => r.expression === "*" && r.action === 0)).toBe(
      false
    )
  })

  it("qualifies the allow rule with a scheme, or SEB parses the host as a URL scheme and blocks everything", () => {
    // Regression: `localhost:3000/*` (no ://) makes SEB's NSURL read `localhost`
    // as the scheme, leaving host nil — the rule matches nothing and the exam is
    // a blank page. The expression must carry http(s):// so host/port parse.
    const settings = buildSebSettings({ id: "exam1" }, "http://localhost:3000")
    const rules = settings.URLFilterRules as {
      action: number
      expression: string
    }[]
    expect(rules[0].expression).toBe("http://localhost:3000/*")

    const prod = buildSebSettings({ id: "exam1" }, "https://exam.school.ch")
    const prodRules = prod.URLFilterRules as { expression: string }[]
    expect(prodRules[0].expression).toBe("https://exam.school.ch/*")
  })

  it("disables the content filter so the JS Config Key API stays available on macOS", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(settings.URLFilterEnableContentFilter).toBe(false)
  })

  it("enables allowUploads, which SEB defaults to NO — without it FILE_UPLOAD questions cannot be answered", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(settings.allowUploads).toBe(true)
  })

  it("omits enableMacOSAAC, which current SEB lists among its removed settings", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(settings).not.toHaveProperty("enableMacOSAAC")
  })
})

describe("macOS lockdown mode (SEB 3.7 AAC)", () => {
  const baseUrl = "https://exam.school.ch"

  it("pins the automatic policy rather than enforcing AAC, which weakens the lockdown on an old Mac", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    // 0 = Automatic (AAC where macOS supports it, Classic kiosk otherwise).
    // 2 = EnforceAAC would leave a pre-12.1 Mac with AAC disabled at runtime and
    // no Classic fallback — less lockdown than we have today, not more.
    expect(settings.lockdownModePolicy).toBe(0)
    expect(settings.lockdownModePolicy).not.toBe(2)
  })

  it("requires a macOS version where AAC actually exists, so the strong mode cannot silently not apply", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    // SEB's own test is `minMacOSVersion > SEBMinMacOS12` (=10), so 11
    // (SEBMinMacOS13) is the lowest value that guarantees AAC without relying on
    // DNS pre-pinning.
    expect(settings.minMacOSVersion).toBe(11)
    expect(settings.minMacOSVersion as number).toBeGreaterThan(10)
  })

  it("sets allowOpenAndSavePanel alongside the policy, or the file dialog dies under AAC", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    // SEB force-sets this to true only for configs that carry NO
    // lockdownModePolicy key. Pinning the policy opts out of that migration, so
    // the two must travel together: allowUploads without a file dialog is a
    // FILE_UPLOAD question a student cannot answer.
    expect(settings.lockdownModePolicy).toBeDefined()
    expect(settings.allowOpenAndSavePanel).toBe(true)
    expect(settings.allowUploads).toBe(true)
  })

  it("keeps every setting that would force AAC off in the automatic policy disabled", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    // -updateAACAvailablility falls back to Classic kiosk if any capture path is
    // on. None of these are ours to enable without revisiting the lockdown mode.
    expect(settings.allowScreenSharing).toBe(false)
    for (const key of [
      "allowScreenCapture",
      "allowWindowCapture",
      "browserMediaCaptureScreen",
      "enableScreenProctoring",
    ]) {
      expect(settings[key] ?? false).toBe(false)
    }
  })

  it("detects apps holding Accessibility permissions, which is how remote control gets in", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(settings.detectAccessibilityApps).toBe(true)
  })

  it("enforces hardened multi-display, screen-capture, assistant, and kiosk lockdown settings", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    // Multi-display and screen capture
    expect(settings.allowedDisplaysMaxNumber).toBe(1)
    expect(settings.allowedDisplayBuiltinEnforce).toBe(true)
    expect(settings.allowDisplayMirroring).toBe(false)
    expect(settings.screenSharingMacEnforceBlocked).toBe(true)
    expect(settings.blockScreenShotsLegacy).toBe(true)
    expect(settings.enablePrintScreen).toBe(false)
    expect(settings.allowScreenCapture).toBe(false)
    expect(settings.allowWindowCapture).toBe(false)

    // Voice & OS Assistants
    expect(settings.allowSiri).toBe(false)
    expect(settings.allowDictation).toBe(false)
    expect(settings.allowDictionaryLookup).toBe(false)
    expect(settings.enablePrivateClipboardMacEnforce).toBe(true)

    // Windows Kiosk & Service
    expect(settings.enableAltEsc).toBe(false)
    expect(settings.enableCtrlEsc).toBe(false)
    expect(settings.enableStartMenu).toBe(false)
    expect(settings.insideSebEnableStartTaskManager).toBe(false)
    expect(settings.insideSebEnableChangeAPassword).toBe(false)
    expect(settings.insideSebEnableLockThisComputer).toBe(false)
    expect(settings.insideSebEnableLogOff).toBe(false)
    expect(settings.insideSebEnableSwitchUser).toBe(false)
    expect(settings.insideSebEnableShutDown).toBe(false)
    expect(settings.insideSebEnableEaseOfAccess).toBe(false)
    expect(settings.insideSebEnableVmWareClientShade).toBe(false)
    expect(settings.sebServicePolicy).toBe(2)
    expect(settings.autoQuitApplications).toBe(true)

    // Session isolation & sanitation
    expect(settings.removeBrowserProfile).toBe(true)
    expect(settings.useTemporaryDownUploadDirectory).toBe(true)
    expect(settings.newBrowserWindowByLinkBlockForeign).toBe(true)
    expect(settings.browserWindowAllowAddressBar).toBe(false)
    expect(settings.newBrowserWindowAllowAddressBar).toBe(false)
  })

  it("changes the Config Key, so an exam whose key was frozen before this needs re-activation", () => {
    // Documents the deployment constraint rather than guarding behaviour:
    // Exam.sebConfigKey is written set-once and verifySebAccess compares against
    // it, so shipping this mid-exam denies students holding an older .seb file.
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    const withoutHardening = { ...settings }
    delete withoutHardening.lockdownModePolicy
    delete withoutHardening.minMacOSVersion
    delete withoutHardening.allowOpenAndSavePanel
    delete withoutHardening.detectAccessibilityApps

    expect(computeConfigKey(settings)).not.toBe(
      computeConfigKey(withoutHardening)
    )
  })
})

describe("sebAllowedVersionsFromEnv", () => {
  it("defaults to no restriction, matching SEB's own default", () => {
    expect(sebAllowedVersionsFromEnv({})).toEqual([])
  })

  it("splits, trims, and drops blank entries", () => {
    expect(
      sebAllowedVersionsFromEnv({
        SEB_ALLOWED_VERSIONS: " Mac.3.7.1.min, Win.3.10.2.min ,,",
      })
    ).toEqual(["Mac.3.7.1.min", "Win.3.10.2.min"])
  })
})

describe("SEB client version requirement (sebAllowedVersions, SEB 3.7.1)", () => {
  const baseUrl = "https://exam.school.ch"

  it("omits sebAllowedVersions entirely when unset, leaving existing configs' Config Key unaffected", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl, {})
    expect("sebAllowedVersions" in settings).toBe(false)
  })

  it("bakes the configured restrictions into the settings dict", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl, {
      SEB_ALLOWED_VERSIONS: "Mac.3.7.1.min,Win.3.10.2.min",
    })
    expect(settings.sebAllowedVersions).toEqual([
      "Mac.3.7.1.min",
      "Win.3.10.2.min",
    ])
  })

  it("changes the Config Key when set, so deploying it needs pnpm seb:regenerate-keys for already-frozen exams", () => {
    // Documents the deployment constraint rather than guarding behaviour, same
    // as the equivalent macOS-lockdown-mode test above: Exam.sebConfigKey is
    // written set-once and verifySebAccess compares against it, so turning
    // this on while an exam is ACTIVE denies every student holding an
    // already-issued .seb file.
    const withRestriction = computeConfigKey(
      buildSebSettings({ id: "exam1" }, baseUrl, {
        SEB_ALLOWED_VERSIONS: "Mac.3.7.1.min",
      })
    )
    const without = computeConfigKey(
      buildSebSettings({ id: "exam1" }, baseUrl, {})
    )
    expect(withRestriction).not.toBe(without)
  })
})

describe("SEB quit model", () => {
  const baseUrl = "https://exam.school.ch"

  it("points quitURL at a dedicated route, never at a page the app itself redirects to", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    // SEB quits the moment it loads the quit URL. /complete is a redirect target
    // in take/page.tsx and exam-runner, so using it here would slam SEB shut on
    // students opening an exam that is not ACTIVE yet.
    expect(settings.quitURL).toBe("https://exam.school.ch/exam/exam1/quit")
    expect(settings.quitURL).not.toBe(`${baseUrl}/exam/exam1/complete`)
  })

  it("quits without a confirmation prompt once the student reaches the quit URL", () => {
    const settings = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(settings.quitURLConfirm).toBe(false)
  })

  it("hashes the quit password as lowercase hex SHA256 of the UTF-8 password, the format SEB stores", () => {
    const settings = buildSebSettings(
      { id: "exam1", quitPassword: "HUNTER2" },
      baseUrl
    )
    const expected = createHash("sha256")
      .update("HUNTER2", "utf8")
      .digest("hex")
    expect(settings.hashedQuitPassword).toBe(expected)
    expect(settings.hashedQuitPassword).toMatch(/^[0-9a-f]{64}$/)
  })

  it("never puts the plaintext quit password in the file", () => {
    const { file } = generateSebConfig(
      { id: "exam1", quitPassword: "HUNTER2" },
      baseUrl
    )
    const xml = gunzipSync(gunzipSync(file).subarray(4)).toString("utf8")
    expect(xml).toContain("hashedQuitPassword")
    expect(xml).not.toContain("HUNTER2")
  })

  it("gates quitting behind the password: allowQuit alone, with no hash, is a free exit", () => {
    // Regression guard for the bug this replaced — allowQuit:true with an unset
    // hashedQuitPassword (SEB's default is "") let a student quit mid-exam.
    const withPassword = buildSebSettings(
      { id: "exam1", quitPassword: "ABC" },
      baseUrl
    )
    expect(withPassword.allowQuit).toBe(true)
    expect(withPassword.hashedQuitPassword).toBeTruthy()
  })

  it("changes the Config Key when the quit password changes, so a stale key cannot validate a new file", () => {
    const a = generateSebConfig(
      { id: "exam1", quitPassword: "AAA" },
      baseUrl
    ).configKey
    const b = generateSebConfig(
      { id: "exam1", quitPassword: "BBB" },
      baseUrl
    ).configKey
    const none = generateSebConfig({ id: "exam1" }, baseUrl).configKey
    expect(a).not.toBe(b)
    expect(a).not.toBe(none)
  })

  it("is deterministic for a given password, so the persisted key matches every later download", () => {
    const a = generateSebConfig(
      { id: "exam1", quitPassword: "AAA" },
      baseUrl
    ).configKey
    const b = generateSebConfig(
      { id: "exam1", quitPassword: "AAA" },
      baseUrl
    ).configKey
    expect(a).toBe(b)
  })
})

describe("generateQuitPassword", () => {
  it("avoids glyphs that are ambiguous when read off a screen and typed into SEB", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateQuitPassword()).toMatch(
        /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/
      )
    }
  })

  it("does not repeat", () => {
    const seen = new Set(
      Array.from({ length: 500 }, () => generateQuitPassword())
    )
    expect(seen.size).toBe(500)
  })
})

describe("personalized config (auto-login handoff)", () => {
  const baseUrl = "https://exam.school.ch"

  it("routes startURL through /seb-enter with the login token, instead of /take", () => {
    const settings = buildSebSettings(
      { id: "exam1", loginToken: "ott-abc" },
      baseUrl
    )
    expect(settings.startURL).toBe(
      `${baseUrl}/exam/exam1/seb-enter?ott=ott-abc`
    )
  })

  it("percent-encodes the token, so a token containing & or # cannot smuggle extra query parameters into startURL", () => {
    const settings = buildSebSettings(
      { id: "exam1", loginToken: "a&b=c#d" },
      baseUrl
    )
    expect(settings.startURL).toBe(
      `${baseUrl}/exam/exam1/seb-enter?ott=a%26b%3Dc%23d`
    )
  })

  it("leaves the anonymous config byte-for-byte unchanged — Exam.sebConfigKey is already frozen in production, so any drift here denies every student holding an issued .seb file", () => {
    // The guard that matters most in this whole change. Exam.sebConfigKey was
    // frozen set-once from a config built before /seb-enter existed; if adding
    // the loginToken branch perturbed the no-token path at all, every already
    // downloaded config would stop matching and the fail-closed guard would
    // lock out the entire cohort.
    const anonymous = buildSebSettings({ id: "exam1" }, baseUrl)
    expect(anonymous.startURL).toBe(`${baseUrl}/exam/exam1/take`)

    // An explicit null/undefined token must take the same branch as an absent
    // one — the route passes `loginToken: null` for creator previews.
    expect(
      computeConfigKey(
        buildSebSettings({ id: "exam1", loginToken: null }, baseUrl)
      )
    ).toBe(computeConfigKey(anonymous))
    expect(
      computeConfigKey(
        buildSebSettings({ id: "exam1", loginToken: undefined }, baseUrl)
      )
    ).toBe(computeConfigKey(anonymous))
    // An empty string is not a usable token and must not personalize either.
    expect(
      computeConfigKey(
        buildSebSettings({ id: "exam1", loginToken: "" }, baseUrl)
      )
    ).toBe(computeConfigKey(anonymous))
  })

  it("forks the Config Key per student, which is why the key belongs on ExamSession", () => {
    const anonymous = computeConfigKey(
      buildSebSettings({ id: "exam1" }, baseUrl)
    )
    const studentA = computeConfigKey(
      buildSebSettings({ id: "exam1", loginToken: "ott-a" }, baseUrl)
    )
    const studentB = computeConfigKey(
      buildSebSettings({ id: "exam1", loginToken: "ott-b" }, baseUrl)
    )

    expect(studentA).not.toBe(anonymous)
    expect(studentB).not.toBe(anonymous)
    expect(studentA).not.toBe(studentB)
  })

  it("still hashes the take-page token against the take URL, not the /seb-enter startURL", () => {
    // /seb-enter redirects to /take, so by the time the SEB JS API reports a
    // key the page URL is /take. The guard's take-URL candidate has to be
    // computed against that, or every personalized session would fail on its
    // first request.
    const configKey = computeConfigKey(
      buildSebSettings({ id: "exam1", loginToken: "ott-a" }, baseUrl)
    )
    const token = configKeyTokenForUrl(`${baseUrl}/exam/exam1/take`, configKey)
    expect(token).toBe(
      createHash("sha256")
        .update(`${baseUrl}/exam/exam1/take${configKey}`, "utf8")
        .digest("hex")
    )
  })
})
