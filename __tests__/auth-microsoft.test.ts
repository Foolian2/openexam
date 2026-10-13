import { afterEach, describe, expect, it, vi } from "vitest"

// The web tier boots in production without Microsoft login (no Microsoft
// variable set), but configuring any Microsoft variable pins the Entra
// tenant to a GUID (lib/env.ts's microsoftTenantIssue) — lib/auth.ts enforces
// the same rule at module load as a second gate. Importing the module pulls
// betterAuth + prisma + redis, but all connect lazily, so this stays a pure
// unit test.
const BASE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://openexam:pw@localhost:5432/openexam",
  NEXT_PUBLIC_BASE_URL: "https://exam.example.com",
  BETTER_AUTH_URL: "https://exam.example.com",
  BETTER_AUTH_SECRET: "x".repeat(40),
  SCHOOL_STUDENT_DOMAINS: "stud.example-school.ch",
  SCHOOL_TEACHER_DOMAINS: "example-school.ch",
} as const

async function tryImport(): Promise<string> {
  vi.resetModules()
  try {
    await import("@/lib/auth")
    return "ok"
  } catch (e) {
    return (e as Error).message
  }
}

afterEach(() => {
  process.env = { ...BASE }
})

// Every scenario in this file does vi.resetModules() and re-imports
// lib/auth, which pulls the whole better-auth + prisma + redis module graph
// from disk again. That runs in ~1s on its own but can exceed vitest's 5s
// default when all test files compete for the CPU, so these blocks get their
// own budget rather than flaking in CI.
const MODULE_IMPORT_TIMEOUT = { timeout: 30_000 }

describe("lib/auth module-load Microsoft guard", MODULE_IMPORT_TIMEOUT, () => {
  it("boots with Microsoft login fully unconfigured", async () => {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv
    expect(await tryImport()).toBe("ok")
  })

  it("throws on 'common' tenant when Microsoft is configured", async () => {
    process.env = {
      ...BASE,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_TENANT_ID: "common",
    } as unknown as NodeJS.ProcessEnv
    expect(await tryImport()).toMatch(/tenant GUID/)
  })

  it("throws on 'organizations' tenant when Microsoft is configured", async () => {
    process.env = {
      ...BASE,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_TENANT_ID: "organizations",
    } as unknown as NodeJS.ProcessEnv
    expect(await tryImport()).toMatch(/tenant GUID/)
  })

  it("throws on 'consumers' tenant when Microsoft is configured", async () => {
    process.env = {
      ...BASE,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_TENANT_ID: "consumers",
    } as unknown as NodeJS.ProcessEnv
    expect(await tryImport()).toMatch(/tenant GUID/)
  })

  it("throws on a malformed, non-GUID tenant string", async () => {
    process.env = {
      ...BASE,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_TENANT_ID: "not-a-real-tenant-id",
    } as unknown as NodeJS.ProcessEnv
    expect(await tryImport()).toMatch(/tenant GUID/)
  })

  it("boots with a valid pinned Entra tenant GUID", async () => {
    process.env = {
      ...BASE,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_CLIENT_SECRET: "secret",
      MICROSOFT_TENANT_ID: "c358c3f6-5f59-44bc-ac4c-6a950e298842",
    } as unknown as NodeJS.ProcessEnv
    expect(await tryImport()).toBe("ok")
  })
})

// Entra ID sends no `email_verified` claim, so better-auth's generic-OAuth
// provider defaults it to false. The create hook overrides that for accounts
// the school tenant just authenticated — and only for those: a domain-only
// rule would auto-verify a password sign-up on a @example-school.ch address.
describe("lib/auth user.create hook", MODULE_IMPORT_TIMEOUT, () => {
  async function runHook(
    email: string,
    path: string | undefined,
    // Password sign-ups must acknowledge the Datenschutzerklärung; the
    // role/verification scenarios below aren't about that, so they send it.
    body: Record<string, unknown> = { acceptPrivacy: true }
  ): Promise<
    | {
        role?: string
        emailVerified?: boolean
        privacyAcceptedAt?: Date
        privacyPolicyVersion?: string
      }
    | undefined
  > {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv
    vi.resetModules()
    const { auth } = await import("@/lib/auth")
    const before = auth.options.databaseHooks?.user?.create?.before
    if (!before) throw new Error("user.create.before hook is not registered")
    const result = await before(
      { email, name: "Test User", emailVerified: false } as never,
      (path ? { path, body } : undefined) as never
    )
    return (result as { data?: Record<string, unknown> } | undefined)?.data
  }

  it("verifies a student arriving through the Microsoft callback", async () => {
    const data = await runHook(
      "first.last@stud.example-school.ch",
      "/callback/microsoft-entra-id"
    )
    expect(data).toMatchObject({ role: "STUDENT", emailVerified: true })
  })

  it("verifies a teacher arriving through the Microsoft callback", async () => {
    const data = await runHook(
      "first.last@example-school.ch",
      "/callback/microsoft-entra-id"
    )
    expect(data).toMatchObject({ role: "TEACHER", emailVerified: true })
  })

  it("leaves a password sign-up on a school address unverified", async () => {
    // The hook passes the incoming user through untouched apart from `role`,
    // so the flag better-auth supplied (false, pre-verification) survives.
    const data = await runHook("first.last@example-school.ch", "/sign-up/email")
    expect(data).toMatchObject({ role: "TEACHER", emailVerified: false })
  })

  it("rejects a non-school address on the Microsoft callback", async () => {
    await expect(
      runHook("someone@gmail.com", "/callback/microsoft-entra-id")
    ).rejects.toMatchObject({ body: { code: "SCHOOL_DOMAIN_REQUIRED" } })
  })

  it("leaves a non-school password sign-up's role untouched", async () => {
    const data = await runHook("someone@gmail.com", "/sign-up/email")
    expect(data?.role).toBeUndefined()
    expect(data?.emailVerified).toBe(false)
  })
})

// The registration checkbox is UI only; this hook is the rule. It covers both
// /register (signUp.email) and /api/teacher/register (auth.api.signUpEmail).
describe("lib/auth privacy acknowledgement", MODULE_IMPORT_TIMEOUT, () => {
  async function runHook(
    email: string,
    context: { path: string; body?: Record<string, unknown> } | undefined
  ) {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv
    vi.resetModules()
    const { auth } = await import("@/lib/auth")
    const before = auth.options.databaseHooks!.user!.create!.before!
    const result = await before(
      { email, name: "Test User", emailVerified: false } as never,
      context as never
    )
    return (result as { data?: Record<string, unknown> } | undefined)?.data
  }

  it.each([undefined, false, "true", 1])(
    "rejects a password sign-up with acceptPrivacy=%s",
    async (acceptPrivacy) => {
      await expect(
        runHook("someone@gmail.com", {
          path: "/sign-up/email",
          body: acceptPrivacy === undefined ? {} : { acceptPrivacy },
        })
      ).rejects.toMatchObject({ body: { code: "PRIVACY_NOT_ACCEPTED" } })
    }
  )

  it("records timestamp and policy version for an accepted sign-up", async () => {
    const { PRIVACY_POLICY_VERSION } = await import("@/lib/legal/config")
    const data = await runHook("first.last@example-school.ch", {
      path: "/sign-up/email",
      body: { acceptPrivacy: true },
    })
    expect(data?.privacyAcceptedAt).toBeInstanceOf(Date)
    expect(data?.privacyPolicyVersion).toBe(PRIVACY_POLICY_VERSION)
    // Recording acceptance must not disturb role derivation.
    expect(data?.role).toBe("TEACHER")
  })

  it("records acceptance for Microsoft sign-in (notice next to the button)", async () => {
    const data = await runHook("first.last@stud.example-school.ch", {
      path: "/callback/microsoft-entra-id",
    })
    expect(data?.privacyAcceptedAt).toBeInstanceOf(Date)
  })

  it("uses LEGAL_POLICY_VERSION when the operator sets one", async () => {
    process.env = {
      ...BASE,
      LEGAL_POLICY_VERSION: "2027-01-01",
    } as unknown as NodeJS.ProcessEnv
    vi.resetModules()
    const { auth } = await import("@/lib/auth")
    const result = await auth.options.databaseHooks!.user!.create!.before!(
      { email: "a@b.ch", name: "A", emailVerified: false } as never,
      { path: "/sign-up/email", body: { acceptPrivacy: true } } as never
    )
    expect(
      (result as { data: { privacyPolicyVersion: string } }).data
        .privacyPolicyVersion
    ).toBe("2027-01-01")
  })

  it("records nothing for creation paths without an acknowledgement", async () => {
    expect(await runHook("someone@gmail.com", undefined)).toBeUndefined()
  })

  it("audit-logs the acknowledgement once the user exists", async () => {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv
    vi.resetModules()
    const createAuditLog = vi.fn().mockResolvedValue(undefined)
    vi.doMock("@/lib/audit", () => ({ createAuditLog }))
    try {
      const { auth } = await import("@/lib/auth")
      const after = auth.options.databaseHooks!.user!.create!.after!
      await after(
        {
          id: "user-1",
          email: "a@b.ch",
          privacyAcceptedAt: new Date(),
          privacyPolicyVersion: "2026-09-16",
        } as never,
        {
          path: "/sign-up/email",
          headers: new Headers({
            "x-forwarded-for": "203.0.113.7",
            "user-agent": "vitest",
          }),
        } as never
      )
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "PRIVACY_POLICY_ACCEPTED",
          userId: "user-1",
          metadata: { version: "2026-09-16", method: "form" },
          ipAddress: "203.0.113.7",
          userAgent: "vitest",
        })
      )

      createAuditLog.mockClear()
      await after({ id: "user-2", email: "c@d.ch" } as never, null as never)
      expect(createAuditLog).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock("@/lib/audit")
    }
  })
})

// A student who registered with a password must still be able to sign in
// with Microsoft later. Entra ID sends no `email_verified` claim, so
// better-auth links the two only when the provider is trusted; the
// account.create hook then keeps that linking to the school domains.
describe("lib/auth Microsoft account linking", MODULE_IMPORT_TIMEOUT, () => {
  async function loadAuth() {
    process.env = { ...BASE } as unknown as NodeJS.ProcessEnv
    vi.resetModules()
    return (await import("@/lib/auth")).auth
  }

  async function runAccountHook(
    providerId: string,
    user: { email: string } | null
  ) {
    const auth = await loadAuth()
    const before = auth.options.databaseHooks?.account?.create?.before
    if (!before) throw new Error("account.create.before hook is not registered")
    const findUserById = vi.fn().mockResolvedValue(user)
    const result = await before(
      { providerId, accountId: "oid-1", userId: "user-1" } as never,
      {
        path: "/callback/microsoft-entra-id",
        context: { internalAdapter: { findUserById } },
      } as never
    )
    return { result, findUserById }
  }

  it("trusts Microsoft for linking but requires a verified local account", async () => {
    const auth = await loadAuth()
    expect(auth.options.account?.accountLinking).toMatchObject({
      trustedProviders: ["microsoft-entra-id"],
      requireLocalEmailVerified: true,
    })
  })

  it.each([
    "first.last@stud.example-school.ch",
    "first.last@example-school.ch",
  ])("lets a Microsoft login attach to %s", async (email) => {
    const { result, findUserById } = await runAccountHook(
      "microsoft-entra-id",
      { email }
    )
    expect(result).toBeUndefined()
    expect(findUserById).toHaveBeenCalledWith("user-1")
  })

  it("refuses to attach a Microsoft login to a non-school account", async () => {
    await expect(
      runAccountHook("microsoft-entra-id", { email: "someone@gmail.com" })
    ).rejects.toMatchObject({ body: { code: "SCHOOL_DOMAIN_REQUIRED" } })
  })

  it("refuses a Microsoft login whose user cannot be found", async () => {
    await expect(
      runAccountHook("microsoft-entra-id", null)
    ).rejects.toMatchObject({ body: { code: "SCHOOL_DOMAIN_REQUIRED" } })
  })

  it("leaves password accounts alone", async () => {
    const { result, findUserById } = await runAccountHook("credential", {
      email: "someone@gmail.com",
    })
    expect(result).toBeUndefined()
    expect(findUserById).not.toHaveBeenCalled()
  })
})
