import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { registerSchema } from "@/lib/validators/auth"
import { STORAGE_INVENTORY } from "@/lib/legal/storage-inventory"
import {
  EXAM_TEXT_SIZE_KEY,
  PRE_EXAM_THEME_KEY,
  TAB_ID_KEY,
} from "@/lib/pre-exam-theme"
import * as storageKeys from "@/lib/storage-keys"
import { PUBLIC_ROUTES } from "@/proxy"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("registerSchema privacy acknowledgement", () => {
  const valid = {
    name: "Max Muster",
    email: "max@schule.ch",
    password: "password123",
    confirmPassword: "password123",
    acceptPrivacy: true,
  }

  it("accepts a ticked checkbox", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true)
  })

  it("rejects an unticked checkbox with a German message on the field", () => {
    const result = registerSchema.safeParse({ ...valid, acceptPrivacy: false })
    expect(result.success).toBe(false)
    const issue = result.error?.issues.find(
      (i) => i.path[0] === "acceptPrivacy"
    )
    expect(issue?.message).toMatch(/Datenschutzerklärung/)
  })
})

describe("STORAGE_INVENTORY (cookie table on /datenschutz)", () => {
  const listed = STORAGE_INVENTORY.flatMap((e) => e.names).join("\n")

  // Every browser-side key the code writes must be disclosed. The constants
  // are imported from where the code reads them, so a new key added to
  // lib/storage-keys.ts without an inventory entry fails here.
  const stringKeys = Object.entries(storageKeys).flatMap(([name, value]) =>
    name.endsWith("_MAX_AGE") || name.endsWith("_SECONDS")
      ? []
      : Array.isArray(value)
        ? value
        : [value as string]
  )

  it.each([...stringKeys, PRE_EXAM_THEME_KEY, EXAM_TEXT_SIZE_KEY, TAB_ID_KEY])(
    "lists %s",
    (key) => {
      expect(listed).toContain(key)
    }
  )

  it("gives every entry a purpose and duration", () => {
    for (const entry of STORAGE_INVENTORY) {
      expect(entry.purpose.length).toBeGreaterThan(10)
      expect(entry.duration.length).toBeGreaterThan(0)
    }
  })
})

describe("legal pages are public", () => {
  it.each(["/datenschutz", "/impressum"])("%s needs no session", (route) => {
    expect(PUBLIC_ROUTES).toContain(route)
  })
})

describe("getLegalConfig", () => {
  async function load(env: Record<string, string>) {
    process.env = {
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://openexam:pw@localhost:5432/openexam",
      BETTER_AUTH_SECRET: "x".repeat(40),
      MATCHING_ID_SECRET: "x".repeat(40),
      TEACHER_ACCESS_CODE: "teachercode1234",
      ...env,
    } as unknown as NodeJS.ProcessEnv
    vi.resetModules()
    const { getLegalConfig } = await import("@/lib/legal/config")
    return getLegalConfig()
  }

  it("splits the address on literal \\n from .env files", async () => {
    const config = await load({
      LEGAL_CONTROLLER_ADDRESS: "Schulstrasse 1\\n8000 Zürich",
    })
    expect(config.controllerAddress).toEqual(["Schulstrasse 1", "8000 Zürich"])
  })

  it("falls back to visible placeholders in development", async () => {
    const config = await load({})
    expect(config.controllerName).toMatch(/LEGAL_CONTROLLER_NAME/)
    expect(config.dpoEmail).toBeNull()
  })

  it("only mentions error tracking when a DSN is configured", async () => {
    expect((await load({})).errorTrackingEnabled).toBe(false)
    expect(
      (await load({ SENTRY_DSN: "http://key@glitchtip-web:8000/1" }))
        .errorTrackingEnabled
    ).toBe(true)
  })

  it("only mentions off-site backups when the SFTP backend is selected", async () => {
    expect((await load({})).offsiteBackupEnabled).toBe(false)
    expect(
      (await load({ WALG_STORAGE_BACKEND: "disabled" })).offsiteBackupEnabled
    ).toBe(false)
    const sftp = await load({
      WALG_STORAGE_BACKEND: "sftp",
      LEGAL_BACKUP_PROVIDER: "Storage Box (DE)",
    })
    expect(sftp.offsiteBackupEnabled).toBe(true)
    expect(sftp.backupProvider).toBe("Storage Box (DE)")
  })
})

describe("privacy page external resource disclosure", () => {
  async function renderPrivacyPage(overrides: Record<string, unknown> = {}) {
    vi.resetModules()
    vi.doMock("next/server", () => ({
      connection: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock("@/lib/legal/config", () => ({
      getLegalConfig: () => ({
        controllerName: "Test School",
        controllerAddress: ["Teststrasse 1"],
        contactEmail: "contact@example.test",
        hostingProvider: "School server",
        policyVersion: "2026-09-16",
        retentionNote: "School retention policy",
        microsoftLoginEnabled: false,
        errorTrackingEnabled: false,
        offsiteBackupEnabled: false,
        backupProvider: null,
        ...overrides,
      }),
    }))
    try {
      const { default: PrivacyPage } =
        await import("@/app/(legal)/datenschutz/page")
      return renderToStaticMarkup(await PrivacyPage())
    } finally {
      vi.doUnmock("next/server")
      vi.doUnmock("@/lib/legal/config")
    }
  }

  it("discloses CDN requests independently of the browser storage table", async () => {
    const html = await renderPrivacyPage()
    expect(html).toContain("cdn.jsdelivr.net")
    expect(html).toContain("IP-Adresse und Browserkennung")
    expect(html).toContain("Bot-Schutz-Widget")
    expect(html).toContain("Code-Editor")
    expect(html).not.toContain("keine Daten an Dritte übermittelt")
    expect(html).not.toContain("keine externen Schriftarten, Skripte")
    expect(html).not.toContain("Sicherungsserver")
  })

  it("discloses encrypted off-site backups when they are enabled", async () => {
    const html = await renderPrivacyPage({
      offsiteBackupEnabled: true,
      backupProvider: "Storage Box (DE)",
    })
    expect(html).toContain(
      "separaten Sicherungsserver übertragen (Storage Box (DE))"
    )
    expect(html).toContain("verschlüsselt")
  })
})
