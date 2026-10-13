import { afterEach, describe, expect, it, vi } from "vitest"

const ORIGINAL_ENV = { ...process.env }

// The web tier's environment in docker-compose.prod.yml: everything lib/env.ts
// enforces in production EXCEPT CAP_ADMIN_KEY, which is deliberately confined
// to the cap container (compose never passes it to web).
const MIN_PROD_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://openexam:pw@localhost:5432/openexam",
  NEXT_PUBLIC_BASE_URL: "https://exam.example.com",
  BETTER_AUTH_URL: "https://exam.example.com",
  BETTER_AUTH_SECRET: "x".repeat(40),
  MATCHING_ID_SECRET: "x".repeat(40),
  TEACHER_ACCESS_CODE: "teachercode1234",
  AT_REST_ENC_KEY: "x".repeat(40),
  CAP_SECRET_KEY: "sk-" + "x".repeat(40),
  LEGAL_CONTROLLER_NAME: "Kantonsschule Beispiel",
  LEGAL_CONTROLLER_ADDRESS: "Schulstrasse 1\\n8000 Zürich",
  LEGAL_CONTACT_EMAIL: "datenschutz@schule.example.ch",
  LEGAL_HOSTING_PROVIDER: "Hetzner Online GmbH, Falkenstein (DE)",
}

// process.env's NODE_ENV is a string union; spreading widens it, so the
// double cast is needed to satisfy NodeJS.ProcessEnv. Overriding a key with
// undefined removes it — CI's workflow-level env block always sets
// MICROSOFT_TENANT_ID (so `next build` boots), which would otherwise leak
// into scenarios that assume Microsoft login is unconfigured. Also scrub any
// inherited MICROSOFT_ vars from the base env up front, so scenarios that
// assert the unconfigured path don't need to enumerate every var themselves.
function setEnv(overrides: Record<string, string | undefined>) {
  const next: Record<string, string | undefined> = { ...ORIGINAL_ENV }
  for (const key of Object.keys(next)) {
    if (key.startsWith("MICROSOFT_")) delete next[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  process.env = next as unknown as NodeJS.ProcessEnv
}

// Any Microsoft var opts into Entra login (lib/env.ts), so scenarios that
// assert the unconfigured path must strip all of them from the base env.
const NO_MICROSOFT = {
  MICROSOFT_CLIENT_ID: undefined,
  MICROSOFT_CLIENT_SECRET: undefined,
  MICROSOFT_TENANT_ID: undefined,
}

async function validate() {
  // validateEnv caches its result in module state, so a fresh module import
  // per scenario is required to observe different environments.
  vi.resetModules()
  const { validateEnv } = await import("@/lib/env")
  return validateEnv()
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("validateEnv in production", () => {
  it("boots without CAP_ADMIN_KEY (web tier never receives it)", async () => {
    setEnv(MIN_PROD_ENV)
    await expect(validate()).resolves.toBeDefined()
  })

  it("still rejects a too-short CAP_ADMIN_KEY when one is present", async () => {
    setEnv({ ...MIN_PROD_ENV, CAP_ADMIN_KEY: "short" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects placeholder CAP_SECRET_KEY from .env.example", async () => {
    setEnv({ ...MIN_PROD_ENV, CAP_SECRET_KEY: "sk-change-me" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("boots with Microsoft login fully unconfigured (prod without Microsoft)", async () => {
    setEnv({ ...MIN_PROD_ENV, ...NO_MICROSOFT })
    await expect(validate()).resolves.toBeDefined()
  })

  it("boots with a valid pinned Entra tenant GUID", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_CLIENT_SECRET: "secret",
      MICROSOFT_TENANT_ID: "c358c3f6-5f59-44bc-ac4c-6a950e298842",
      SCHOOL_TEACHER_DOMAINS: "example-school.ch",
    })
    await expect(validate()).resolves.toBeDefined()
  })

  it("rejects Microsoft login without any school domain", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_CLIENT_SECRET: "secret",
      MICROSOFT_TENANT_ID: "c358c3f6-5f59-44bc-ac4c-6a950e298842",
    })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects a domain listed as both student and teacher", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      ...NO_MICROSOFT,
      SCHOOL_STUDENT_DOMAINS: "example-school.ch",
      SCHOOL_TEACHER_DOMAINS: "example-school.ch",
    })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects 'common' tenant when Microsoft is configured", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
      MICROSOFT_TENANT_ID: "common",
    })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects a missing tenant when Microsoft is partially configured", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      ...NO_MICROSOFT,
      MICROSOFT_CLIENT_ID: "69194938-d812-4cef-afaf-945497d62441",
    })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("boots with SENTRY_DSN set to empty string (docker-compose.prod.yml's disabled default)", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      SENTRY_DSN: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
    })
    await expect(validate()).resolves.toBeDefined()
  })

  it("rejects a non-empty, non-URL SENTRY_DSN", async () => {
    setEnv({ ...MIN_PROD_ENV, SENTRY_DSN: "not-a-url" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  // Regression: docker-compose.prod.yml passed NEXT_PUBLIC_BASE_URL as a
  // Docker build arg (correctly baked into the client bundle) but omitted it
  // from the web service's runtime `environment:` block. Server-side code
  // (the SEB launch page, the .seb config route) reads process.env live at
  // request time — with the var absent there, every server-generated SEB
  // link silently fell back to lib/seb-urls.ts's http://localhost:3000 dev
  // default, on a fully "healthy" container. This must fail loudly at boot
  // instead.
  it("rejects a missing NEXT_PUBLIC_BASE_URL in production", async () => {
    setEnv({ ...MIN_PROD_ENV, NEXT_PUBLIC_BASE_URL: undefined })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("boots with a well-formed SEB_ALLOWED_VERSIONS", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      SEB_ALLOWED_VERSIONS: "Mac.3.7.1.min,Win.3.10.2.min",
    })
    await expect(validate()).resolves.toBeDefined()
  })

  it("rejects a malformed SEB_ALLOWED_VERSIONS token", async () => {
    setEnv({ ...MIN_PROD_ENV, SEB_ALLOWED_VERSIONS: "Mac.3.7.x.min" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects an unsupported OS identifier in SEB_ALLOWED_VERSIONS", async () => {
    setEnv({ ...MIN_PROD_ENV, SEB_ALLOWED_VERSIONS: "Linux.3.7.1.min" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  // /datenschutz must name the real school as controller in production.
  it.each([
    "LEGAL_CONTROLLER_NAME",
    "LEGAL_CONTROLLER_ADDRESS",
    "LEGAL_CONTACT_EMAIL",
    "LEGAL_HOSTING_PROVIDER",
  ])("rejects a missing %s", async (key) => {
    setEnv({ ...MIN_PROD_ENV, [key]: undefined })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects an empty LEGAL_CONTROLLER_NAME (compose's unset default)", async () => {
    setEnv({ ...MIN_PROD_ENV, LEGAL_CONTROLLER_NAME: "" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects a placeholder LEGAL_HOSTING_PROVIDER", async () => {
    setEnv({ ...MIN_PROD_ENV, LEGAL_HOSTING_PROVIDER: "change-me" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("rejects a LEGAL_DPO_EMAIL that isn't an email address", async () => {
    setEnv({ ...MIN_PROD_ENV, LEGAL_DPO_EMAIL: "Frau Muster" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("boots with empty optional LEGAL_* values", async () => {
    setEnv({
      ...MIN_PROD_ENV,
      LEGAL_DPO_NAME: "",
      LEGAL_DPO_EMAIL: "",
      LEGAL_CONTACT_PHONE: "",
      LEGAL_POLICY_VERSION: "",
    })
    await expect(validate()).resolves.toBeDefined()
  })
})

describe("validateEnv SEB_ALLOWED_VERSIONS outside production", () => {
  // A malformed restriction is a deploy-time typo regardless of environment —
  // catching it only in production would let it boot silently in dev/CI and
  // surface only once a real exam freezes a config with it.
  const MIN_DEV_ENV = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://openexam:pw@localhost:5432/openexam",
    BETTER_AUTH_SECRET: "x".repeat(40),
    MATCHING_ID_SECRET: "x".repeat(40),
    TEACHER_ACCESS_CODE: "teachercode1234",
  }

  it("rejects a malformed token even when NODE_ENV is not production", async () => {
    setEnv({ ...MIN_DEV_ENV, SEB_ALLOWED_VERSIONS: "Mac.3.7.x.min" })
    await expect(validate()).rejects.toThrow(/Environment validation failed/)
  })

  it("boots with SEB_ALLOWED_VERSIONS unset outside production", async () => {
    setEnv({ ...MIN_DEV_ENV, SEB_ALLOWED_VERSIONS: undefined })
    await expect(validate()).resolves.toBeDefined()
  })

  it("boots without any LEGAL_* values outside production (.env.example leaves them empty)", async () => {
    setEnv({
      ...MIN_DEV_ENV,
      LEGAL_CONTROLLER_NAME: "",
      LEGAL_CONTROLLER_ADDRESS: "",
      LEGAL_CONTACT_EMAIL: "",
      LEGAL_HOSTING_PROVIDER: "",
    })
    await expect(validate()).resolves.toBeDefined()
  })
})
