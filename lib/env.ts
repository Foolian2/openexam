import { z } from "zod"
import { logError } from "./logger"
import { schoolDomains, schoolDomainsIssue } from "./school-domains"

// Placeholder detection for the "copy .env.example to .env.prod and change
// only the URL" footgun: every example secret is the literal string
// `change-me` (CAP_SECRET_KEY ships the prefixed `sk-change-me`), and
// accepting it in production would hand the repo's public documentation
// value (teacher access code, HMAC key, Cap admin/site key) to anyone who
// reads it.
const PLACEHOLDER_RE =
  /^(sk[-_]?)?(change[-_]?me|changeme|your[-_][a-z0-9-]+|example|placeholder|todo|dummy)$/i

// Production minimum lengths. Better Auth itself demands 32+ for
// BETTER_AUTH_SECRET; the others have no upstream guard, so they are
// enforced here instead of shipping an arbitrarily short key that makes the
// matched IDs HMAC or the teacher code brute-forceable. CAP_ADMIN_KEY/
// CAP_SECRET_KEY gate the Cap CAPTCHA admin dashboard and bot-check
// verification respectively (docker-compose.prod.yml) — .env.example ships
// both as guessable placeholders too.
const PROD_MIN_LENGTHS: Record<string, number> = {
  BETTER_AUTH_SECRET: 32,
  MATCHING_ID_SECRET: 32,
  TEACHER_ACCESS_CODE: 12,
  AT_REST_ENC_KEY: 32,
  CAP_ADMIN_KEY: 16,
  CAP_SECRET_KEY: 16,
}

// Microsoft login is optional: production boots without it when NO Microsoft
// variable is set. Configuring any of them pins the tenant — accepting
// "common"/"organizations"/"consumers" (or omitting the tenant) would let any
// Azure tenant's tokens in, which combined with email-domain-based role
// derivation (lib/school-domains.ts) lets an attacker auto-promote
// to TEACHER.
const INSECURE_TENANTS = new Set(["common", "organizations", "consumers"])
const MICROSOFT_TENANT_GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// SEB's own `OS.Major.Minor[.Patch][.Build][.AE][.min]` grammar for
// sebAllowedVersions restriction strings (lib/seb-config.ts's
// sebAllowedVersionsFromEnv), e.g. "Mac.3.7.1.min" or "Win.3.10.2.min". A
// token that doesn't match this shape (a typo, a missing OS prefix) is a
// non-blank string that would still pass through unvalidated and get baked
// into every downloaded config — since SEB rejects any restriction it can't
// satisfy, one malformed entry quits the whole cohort of that platform at
// launch instead of failing at deploy time. SEB ships Windows, macOS and
// iOS clients, so those are the only platform identifiers validated here.
const SEB_ALLOWED_VERSION_TOKEN_RE =
  /^(Win|Mac|iOS)\.\d+\.\d+(\.\d+){0,2}(\.AE)?(\.min)?$/

/** Error message when the configured Entra tenant isn't a pinned GUID, else null. */
export function microsoftTenantIssue(
  tenant: string | undefined
): string | null {
  const t = tenant?.trim()
  if (
    !t ||
    INSECURE_TENANTS.has(t.toLowerCase()) ||
    !MICROSOFT_TENANT_GUID_RE.test(t)
  ) {
    return (
      "MICROSOFT_TENANT_ID must be set to the school's Entra tenant GUID in production" +
      " (not common/organizations/consumers) when Microsoft login is configured"
    )
  }
  return null
}

/**
 * Whether Microsoft login is configured at all. Mirrors the production
 * boot check above: setting ANY of the three variables opts in (and then
 * the tenant must be a pinned GUID). Pages use this to decide whether to
 * render the Microsoft sign-in button, so the button never disagrees with
 * the boot validation about what "configured" means.
 */
type MicrosoftEnvShape = {
  MICROSOFT_CLIENT_ID?: string | null
  MICROSOFT_CLIENT_SECRET?: string | null
  MICROSOFT_TENANT_ID?: string | null
}

export function microsoftConfigured(
  env: MicrosoftEnvShape = process.env as MicrosoftEnvShape
): boolean {
  return Boolean(
    env.MICROSOFT_CLIENT_ID ||
      env.MICROSOFT_CLIENT_SECRET ||
      env.MICROSOFT_TENANT_ID
  )
}

// Free-text env var where compose's "" for "unset" must read as missing.
function optionalText() {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional()
  )
}

// Legal-page details without which /datenschutz can't name the controller.
export const LEGAL_REQUIRED_IN_PROD = [
  "LEGAL_CONTROLLER_NAME",
  "LEGAL_CONTROLLER_ADDRESS",
  "LEGAL_CONTACT_EMAIL",
  "LEGAL_HOSTING_PROVIDER",
] as const

const envSchema = z
  .object({
    DATABASE_URL: z.string().url("DATABASE_URL must be a valid URL"),
    BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
    MATCHING_ID_SECRET: z.string().min(1, "MATCHING_ID_SECRET is required"),
    TEACHER_ACCESS_CODE: z.string().min(1, "TEACHER_ACCESS_CODE is required"),

    NEXT_PUBLIC_BASE_URL: z.string().url().optional(),
    // Required in production: better-auth builds email verification / reset
    // links from this origin, and deriving it from the request Host header
    // lets an attacker poison those links (see lib/auth.ts).
    BETTER_AUTH_URL: z.string().url().optional(),

    // AES-256-GCM key for at-rest encryption (OAuth tokens, SEB quit
    // password) — lib/at-rest-encryption.ts.
    AT_REST_ENC_KEY: z.string().optional(),

    // Cap CAPTCHA: CAP_SECRET_KEY is read directly in lib/auth.ts to verify
    // solved challenges; CAP_ADMIN_KEY gates the separate Cap container's
    // admin dashboard (docker-compose.prod.yml) and isn't read by this app,
    // but is sourced from the same .env/.env.prod file and is validated here
    // for the same reason as the app's own secrets.
    CAP_ADMIN_KEY: z.string().optional(),
    CAP_SECRET_KEY: z.string().optional(),

    REDIS_URL: z.string().optional(),

    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().optional(),
    SCHOOL_STUDENT_DOMAINS: z.string().optional(),
    SCHOOL_TEACHER_DOMAINS: z.string().optional(),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),

    // GlitchTip (self-hosted error tracker) — instrumentation.ts /
    // instrumentation-client.ts. Empty disables capture; the monitoring
    // stack (scripts/setup-monitoring.sh) is opt-in. docker-compose.prod.yml
    // passes "" (not unset) when disabled, so "" must clear to undefined
    // before the .url() check — .optional() alone only permits undefined.
    SENTRY_DSN: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional()
    ),
    NEXT_PUBLIC_SENTRY_DSN: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional()
    ),

    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
    ALLOWED_ORIGINS: z.string().optional(),

    // Comma-separated SEB "Allowed SEB Versions" restrictions (SEB 3.7.1),
    // e.g. "Mac.3.7.1.min,Win.3.10.2.min". Empty/unset means no restriction —
    // SEB's own default. See sebAllowedVersionsFromEnv in lib/seb-config.ts
    // for why this isn't defaulted to a hardcoded floor.
    SEB_ALLOWED_VERSIONS: z.string().optional(),

    // Operator-specific wording for /datenschutz and /impressum
    // (lib/legal/config.ts). The school running the deployment is the data
    // controller, so these can't ship as defaults. docker-compose.prod.yml
    // passes "" for unset optional ones, hence the "" → undefined preprocess.
    LEGAL_CONTROLLER_NAME: optionalText(),
    LEGAL_CONTROLLER_ADDRESS: optionalText(),
    LEGAL_CONTACT_EMAIL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z
        .string()
        .email("LEGAL_CONTACT_EMAIL must be an email address")
        .optional()
    ),
    LEGAL_CONTACT_PHONE: optionalText(),
    LEGAL_HOSTING_PROVIDER: optionalText(),
    LEGAL_DPO_NAME: optionalText(),
    LEGAL_DPO_EMAIL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().email("LEGAL_DPO_EMAIL must be an email address").optional()
    ),
    LEGAL_IMPRESSUM_RESPONSIBLE: optionalText(),
    LEGAL_RETENTION_NOTE: optionalText(),
    LEGAL_POLICY_VERSION: optionalText(),
    LEGAL_BACKUP_PROVIDER: optionalText(),
    // Read only so /datenschutz can disclose off-site backups; the backup
    // overlay itself is selected by scripts/lib/production-compose.sh.
    WALG_STORAGE_BACKEND: optionalText(),
  })
  .superRefine((env, ctx) => {
    // Validated regardless of NODE_ENV: a malformed restriction is a
    // deployment-time typo, not a production-only concern, and letting it
    // through to boot successfully in dev only delays discovery to whatever
    // environment first freezes a config with it.
    if (env.SEB_ALLOWED_VERSIONS) {
      const tokens = env.SEB_ALLOWED_VERSIONS.split(",")
        .map((v) => v.trim())
        .filter(Boolean)
      for (const token of tokens) {
        if (!SEB_ALLOWED_VERSION_TOKEN_RE.test(token)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["SEB_ALLOWED_VERSIONS"],
            message: `SEB_ALLOWED_VERSIONS: "${token}" does not match SEB's OS.Major.Minor[.Patch][.Build][.AE][.min] format (e.g. "Mac.3.7.1.min"); OS must be Win, Mac, or iOS`,
          })
        }
      }
    }

    const domainIssue = schoolDomainsIssue(env)
    if (domainIssue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SCHOOL_STUDENT_DOMAINS"],
        message: domainIssue,
      })
    }

    if (env.NODE_ENV !== "production") return

    if (!env.BETTER_AUTH_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BETTER_AUTH_URL"],
        message:
          "BETTER_AUTH_URL must be set in production (email verification/reset links are built from it)",
      })
    }
    if (!env.NEXT_PUBLIC_BASE_URL) {
      // Silently falls back to lib/seb-urls.ts's dev default
      // ("http://localhost:3000") otherwise: Next.js only inlines
      // NEXT_PUBLIC_* statically for client/Edge code, so Server Components
      // and Route Handlers (the SEB launch page, the .seb config generator)
      // read process.env live and need this set as an actual runtime env
      // var, not just a Docker build arg for the client bundle.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["NEXT_PUBLIC_BASE_URL"],
        message:
          "NEXT_PUBLIC_BASE_URL must be set in production (server-side code — e.g. the SEB launch link — reads it at request time and silently falls back to http://localhost:3000 otherwise)",
      })
    }
    if (!env.AT_REST_ENC_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AT_REST_ENC_KEY"],
        message:
          "AT_REST_ENC_KEY must be set in production (at-rest encryption of OAuth tokens and SEB quit passwords)",
      })
    }

    // Microsoft login is fully optional: prod boots without it. But setting
    // any Microsoft variable opts in, and then the tenant must be pinned.
    if (microsoftConfigured(env)) {
      const tenantIssue = microsoftTenantIssue(env.MICROSOFT_TENANT_ID)
      if (tenantIssue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MICROSOFT_TENANT_ID"],
          message: tenantIssue,
        })
      }
      // Microsoft logins are only accepted for school-domain addresses, so
      // without any domain every Microsoft sign-in would be rejected.
      const domains = schoolDomains(env)
      if (domains.student.length === 0 && domains.teacher.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SCHOOL_STUDENT_DOMAINS"],
          message:
            "SCHOOL_STUDENT_DOMAINS and/or SCHOOL_TEACHER_DOMAINS must be set when Microsoft login is configured",
        })
      }
    }

    // A privacy policy naming "Beispielschule" as controller is worse than
    // none: it misinforms students about who processes their data.
    for (const key of LEGAL_REQUIRED_IN_PROD) {
      const value = env[key]
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be set in production (shown on /datenschutz and /impressum as the responsible school)`,
        })
      } else if (PLACEHOLDER_RE.test(value.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} still has a placeholder value from .env.example — set the school's real details`,
        })
      }
    }

    for (const [key, min] of Object.entries(PROD_MIN_LENGTHS)) {
      const value = env[key as keyof typeof env]
      // Only enforced when present: docker-compose.prod.yml deliberately
      // keeps CAP_ADMIN_KEY out of the web container's environment (it gates
      // the separate Cap container's admin dashboard), so requiring it here
      // would make the web tier unbootable in prod.
      if (typeof value !== "string") continue
      if (value.length < min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be at least ${min} characters in production`,
        })
        continue
      }
      if (PLACEHOLDER_RE.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} still has a placeholder value from .env.example — set a real secret`,
        })
      }
    }
  })

export type ParsedEnv = z.infer<typeof envSchema>

let _parsed: ParsedEnv | null = null

export function validateEnv(): ParsedEnv {
  if (_parsed) return _parsed

  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    logError("Invalid environment variables", {
      issues: result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`
      ),
    })
    throw new Error("Environment validation failed — see above for details")
  }
  _parsed = result.data
  return _parsed
}

export function getEnv(): ParsedEnv {
  return _parsed ?? validateEnv()
}
