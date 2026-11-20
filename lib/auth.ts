import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { displayNameIssue, normalizeDisplayName } from "@/lib/display-name"
import {
  genericOAuth,
  microsoftEntraId,
} from "better-auth/plugins/generic-oauth"
import { captcha } from "better-auth/plugins"
import { oneTimeToken } from "better-auth/plugins/one-time-token"
import { passkey } from "@better-auth/passkey"
import { AUTH_DISABLED_PATHS } from "@/lib/auth-disabled-paths"
import { LAUNCH_TOKEN_TTL_SECONDS } from "@/lib/seb-launch-token"
import { encryptedPrismaAdapter } from "@/lib/encrypted-prisma-adapter"
import { microsoftConfigured, microsoftTenantIssue } from "@/lib/env"
import { prisma } from "@/lib/prisma"
import { redis } from "@/lib/redis"
import { redisSecondaryStorage } from "@/lib/redis-secondary-storage"
import { logDebug, logWarn } from "@/lib/logger"
import { createAuditLog } from "@/lib/audit"
import { scheduleResetPasswordEmail } from "@/lib/password-reset"
import {
  capSessionRefresh,
  sessionCreatedAtFromHookContext,
} from "@/lib/session-cap"
import { accountKey, accountRateLimitMessage } from "@/lib/account-rate-limit"
import { rateLimit } from "@/lib/rate-limit"
import { withEmailChangeState } from "@/lib/email-change-state"
import { SESSION_MAX_AGE_SECONDS } from "@/lib/storage-keys"
import { getClientIp } from "@/lib/client-ip"
import {
  getPrivacyPolicyVersion,
  PRIVACY_ACCEPTED_AUDIT_ACTION,
} from "@/lib/legal/config"
import { deriveSchoolRole } from "@/lib/school-domains"

// The WebAuthn RP ID is derived from NEXT_PUBLIC_BASE_URL; without it every
// passkey would break in production.
if (
  process.env.NODE_ENV === "production" &&
  !process.env.NEXT_PUBLIC_BASE_URL
) {
  throw new Error("NEXT_PUBLIC_BASE_URL must be set")
}
// Email links must be built from a pinned origin, never the Host header.
if (process.env.NODE_ENV === "production" && !process.env.BETTER_AUTH_URL) {
  throw new Error(
    "BETTER_AUTH_URL must be set to the public HTTPS origin (better-auth builds verification/reset links from it)"
  )
}
const rpID = new URL(
  process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
).hostname

// CI only (ci.yml): the e2e production build has no mailbox, so the hooks
// below log links instead of sending mail. Never set in a real deployment.
const emailVerificationDisabled =
  process.env.DISABLE_EMAIL_VERIFICATION === "true"

// Provider id registered by the microsoftEntraId helper below.
const MICROSOFT_PROVIDER_ID = "microsoft-entra-id"

const SCHOOL_DOMAIN_REQUIRED_MESSAGE =
  "Die Anmeldung mit Microsoft ist nur mit einem Schulkonto möglich."

// Microsoft login is optional: it's disabled entirely when no Microsoft
// variable is set (see lib/env.ts's microsoftTenantIssue). When any of them
// IS set, the tenant MUST be pinned to the school's Entra ID GUID.
// "common"/"organizations"/"consumers" accept tokens issued by any Azure AD
// tenant (incl. personal accounts), which combined with email-domain-based
// role derivation lets an attacker auto-promote to TEACHER.
//
// The check runs in every environment since better-auth 1.7: the
// microsoftEntraId helper itself now rejects a non-GUID tenant (a
// multi-tenant authority needs ID-token claim validation to derive the
// account's real issuer, which the helper doesn't do), so a dev deployment
// that used to fall back to "common" would throw an opaque error deep in
// plugin init instead of this one.
const microsoftTenantId = process.env.MICROSOFT_TENANT_ID
const microsoftLoginConfigured = microsoftConfigured()
if (microsoftLoginConfigured) {
  const tenantIssue = microsoftTenantIssue(microsoftTenantId)
  if (tenantIssue) throw new Error(tenantIssue)
}

// Minimal slice of Better Auth's GenericEndpointContext the user.create
// hooks read — kept structural so the unit tests can pass plain objects.
type HookContext = {
  path?: string
  body?: unknown
  headers?: Headers
  request?: Request
} | null

// better-auth 1.7 moved generic-OAuth callbacks onto the core
// social-provider path: /oauth2/callback/:id is now /callback/:id.
function isSchoolTenantCallback(context: HookContext | undefined): boolean {
  return context?.path?.startsWith("/callback/") === true
}

/**
 * Datenschutzerklärung acknowledgement for a new account (app/(legal)/).
 * Password sign-ups — both /register and /api/teacher/register, which calls
 * auth.api.signUpEmail — must send `acceptPrivacy: true`; the checkbox in the
 * form is only a UI for this server-side rule. Microsoft sign-in has no form:
 * the notice next to the button is the acknowledgement, recorded here. Other
 * creation paths (none today) record nothing rather than a fake timestamp.
 */
function privacyAcceptanceFields(context: HookContext | undefined) {
  const path = context?.path
  if (path === "/sign-up/email") {
    const body = context?.body as { acceptPrivacy?: unknown } | undefined
    if (body?.acceptPrivacy !== true) {
      throw new APIError("BAD_REQUEST", {
        code: "PRIVACY_NOT_ACCEPTED",
        message:
          "Bitte bestätigen Sie, dass Sie die Datenschutzerklärung gelesen haben.",
      })
    }
  } else if (!isSchoolTenantCallback(context)) {
    return null
  }
  return {
    privacyAcceptedAt: new Date(),
    privacyPolicyVersion: getPrivacyPolicyVersion(),
  }
}

// Aggregate cap on the account mails one user can trigger (verification and
// email-change confirmations together). The per-address cooldown in
// emailVerification below lets each new address through, so without this
// one account could mail any number of distinct addresses. Fails open
// without Redis, like the cooldown.
const ACCOUNT_MAIL_LIMIT = 10
const ACCOUNT_MAIL_WINDOW_SECONDS = 60 * 60

async function withinAccountMailBudget(userId: string): Promise<boolean> {
  const { allowed } = await rateLimit(
    `account-mail:${userId}`,
    ACCOUNT_MAIL_LIMIT,
    ACCOUNT_MAIL_WINDOW_SECONDS,
    "open"
  )
  if (!allowed) logWarn("Account mail limit reached", { userId })
  return allowed
}

export const auth = betterAuth({
  // Pinned origin for email links, trustedOrigins and the origin check. When
  // unset (dev), better-auth falls back to the request origin, which is
  // fine on localhost; production refuses to boot without it (see above).
  baseURL: process.env.BETTER_AUTH_URL,
  // Wrapped adapter: OAuth tokens are AES-256-GCM encrypted at rest
  // (lib/encrypted-prisma-adapter.ts).
  database: encryptedPrismaAdapter(prisma, { provider: "postgresql" }),
  // Server-only endpoints (the SEB one-time-token handoff): 404 over HTTP,
  // still callable as auth.api.*. See lib/auth-disabled-paths.ts.
  disabledPaths: AUTH_DISABLED_PATHS,
  // Our own error page; Better Auth's drops non-alphanumeric error codes.
  onAPIError: {
    errorURL: "/error",
  },
  // Redis-backed so rate-limit counters are shared across instances.
  secondaryStorage: redisSecondaryStorage,
  // Always on in production; DISABLE_RATE_LIMIT works only outside it.
  rateLimit: {
    enabled:
      process.env.NODE_ENV === "production" ||
      process.env.DISABLE_RATE_LIMIT !== "true",
    storage: "secondary-storage",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
      "/passkey/generate-authenticate-options": { window: 60, max: 5 },
      "/passkey/verify-authentication": { window: 60, max: 5 },
      "/passkey/generate-register-options": { window: 60, max: 5 },
      "/passkey/verify-registration": { window: 60, max: 5 },
    },
  },
  hooks: {
    // Per-account throttle on sign-in and reset requests (lib/account-rate-limit.ts).
    before: createAuthMiddleware(async (ctx) => {
      const nameIssue = displayNameIssue(ctx.path, ctx.body)
      if (nameIssue) {
        throw new APIError("BAD_REQUEST", {
          code: "INVALID_NAME",
          message: nameIssue,
        })
      }
      const message = await accountRateLimitMessage(ctx.path, ctx.body)
      // The code lets the client keep this German message (with its wait
      // time) instead of the generic 429 text (lib/auth-error-message.ts).
      if (message) {
        throw new APIError("TOO_MANY_REQUESTS", {
          message,
          code: "ACCOUNT_RATE_LIMITED",
        })
      }
    }),
  },
  session: {
    expiresIn: SESSION_MAX_AGE_SECONDS,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      // Disabled: it would keep serving stale roles after a change or
      // revocation.
      enabled: false,
    },
    // Required: ws-backend looks up sessions in Postgres only.
    storeSessionInDatabase: true,
  },
  account: {
    accountLinking: {
      // Entra ID sends no `email_verified` claim, so without trusting the
      // provider a student who registered with a password could never sign
      // in with Microsoft afterwards (better-auth: "account not linked").
      // The tenant is pinned to the school's GUID, so the address comes
      // from the school directory; the account.create hook below limits
      // linking to the school domains.
      trustedProviders: [MICROSOFT_PROVIDER_ID],
      // Keep better-auth's default explicit: the local account must have
      // proven its mailbox. Otherwise whoever registered a student's
      // address with a password first would receive their Microsoft login.
      requireLocalEmailVerified: true,
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification:
      !emailVerificationDisabled && process.env.NODE_ENV !== "development",
    // Self-service password reset (PRODUCT-RISK-DECISIONS R3b). The link is
    // single-use, valid 30 minutes, and every session of the account is
    // revoked once the new password is set — a reset after a compromise must
    // also end the attacker's session. /request-password-reset answers the
    // same whether or not the address exists (better-auth), is captcha-gated
    // (captcha plugin default endpoints) and throttled per IP (customRules)
    // and per account (lib/account-rate-limit.ts).
    resetPasswordTokenExpiresIn: 30 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: (data) =>
      scheduleResetPasswordEmail(
        data,
        process.env.NODE_ENV === "development" || emailVerificationDisabled
      ),
    onPasswordReset: async ({ user }) => {
      await createAuditLog({
        action: "PASSWORD_RESET_COMPLETED",
        entityType: "User",
        entityId: user.id,
        userId: user.id,
      })
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    // Re-send on sign-in in case the first mail was lost (rate-limited below).
    sendOnSignIn: true,
    // 24h verification window (better-auth's default is 1h): registration
    // asks the teacher to verify within the day.
    expiresIn: 24 * 60 * 60,
    sendVerificationEmail: async ({ user, url }) => {
      // At most one mail per user and address per 5 minutes; fails open
      // without Redis. The address is part of the key because this hook also
      // sends the second step of an email change (to the NEW address, see
      // user.changeEmail below): keyed on the user alone, that mail was
      // silently dropped whenever another verification mail had gone out
      // within the window. Hashed like lib/account-rate-limit.ts's keys, so
      // Redis carries no address.
      try {
        const acquired = await redis.set(
          `verify-email:cooldown:${user.id}:${accountKey(user.email)}`,
          "1",
          "EX",
          5 * 60,
          "NX"
        )
        if (acquired !== "OK") return
      } catch {
        // Redis unreachable — send anyway.
      }
      if (!(await withinAccountMailBudget(user.id))) return
      if (process.env.NODE_ENV === "development" || emailVerificationDisabled) {
        logDebug("Verify email link", { email: user.email, url })
        return
      }
      const { sendEmail } = await import("./email")
      await sendEmail({
        to: user.email,
        subject: "OpenExam — E-Mail-Adresse bestätigen",
        text: `Hallo ${user.name},\n\nbitte bestätige deine E-Mail-Adresse:\n${url}\n\nFalls du dich nicht bei OpenExam registriert hast, ignoriere diese E-Mail.`,
      })
    },
  },
  user: {
    changeEmail: {
      enabled: true,
      // Two steps (better-auth's contract): this confirmation goes to the OLD
      // address. Clicking it does NOT change the email yet — better-auth then
      // calls emailVerification.sendVerificationEmail with the NEW address,
      // and only that second link switches the account over. Both links
      // redirect to the callbackURL the settings form sets, extended below
      // by the signed requested address, so the settings page
      // (components/settings/email-form.tsx) can tell the user which step
      // they are on.
      sendChangeEmailConfirmation: async ({ user, newEmail, url: link }) => {
        if (!(await withinAccountMailBudget(user.id))) return
        // The callbackURL carries the requested address, signed, so the
        // settings page can trust it (lib/email-change-state.ts); better-auth
        // copies it into the second link.
        const url = withEmailChangeState(link, user.id, newEmail)
        if (
          process.env.NODE_ENV === "development" ||
          emailVerificationDisabled
        ) {
          logDebug("Change email link", { from: user.email, to: newEmail, url })
          return
        }
        const { sendEmail } = await import("./email")
        await sendEmail({
          to: user.email,
          subject: "OpenExam — E-Mail-Adresse ändern bestätigen",
          text: `Hallo ${user.name},\n\ndu hast angefordert, deine E-Mail-Adresse zu ${newEmail} zu ändern. Bitte bestätige die Änderung:\n${url}\n\nDanach erhältst du an ${newEmail} einen zweiten Link. Erst wenn du auch diesen öffnest, wird die neue Adresse wirksam.\n\nFalls du diese Änderung nicht angefordert hast, ignoriere diese E-Mail.`,
        })
      },
    },
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "STUDENT",
        input: false,
      },
      dyslexicFont: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: true,
      },
      highContrast: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: true,
      },
      reducedMotion: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: true,
      },
      hideExamTimer: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: true,
      },
      // Set only by the user.create hook below (input: false — a client
      // sending them is rejected by better-auth).
      privacyAcceptedAt: {
        type: "date",
        required: false,
        input: false,
      },
      privacyPolicyVersion: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  databaseHooks: {
    session: {
      update: {
        // Absolute 30-day cap on sliding sessions. This runs before
        // better-auth writes the refresh to Redis AND Postgres, and
        // getSession has already put the session being refreshed (with its
        // createdAt) on the endpoint context. See lib/session-cap.ts.
        before: async (data, context) => {
          const createdAt = sessionCreatedAtFromHookContext(context)
          if (data.expiresAt && !createdAt) {
            // better-auth moved the session off the hook context, so this
            // hook can no longer refuse or clamp refreshes. The Redis read
            // clamp and the Postgres trigger still apply; make it visible.
            logWarn("Session refresh without createdAt; absolute cap skipped")
          }
          const decision = capSessionRefresh(data, createdAt)
          if (decision === false) return false
          // The hook's declared data type is better-auth's internal Optional<>
          // shape; the clamped object only replaces expiresAt.
          if (decision)
            return decision as { data: typeof data & { id: string } }
        },
      },
    },
    account: {
      create: {
        // Microsoft is a trusted provider for linking (see accountLinking
        // above), so an existing account with the same address gets the
        // Microsoft login attached without passing through user.create's
        // domain check. Apply the same rule here: only school accounts may
        // carry a Microsoft login. Runs for new sign-ups too, which the
        // user.create hook has already restricted to the school domains.
        before: async (account, context) => {
          if (account.providerId !== MICROSOFT_PROVIDER_ID) return
          // The transaction-aware adapter: on a new sign-up the user row
          // exists only inside better-auth's still-open transaction.
          const user = await context?.context.internalAdapter.findUserById(
            account.userId
          )
          if (!user || !deriveSchoolRole(user.email)) {
            throw new APIError("FORBIDDEN", {
              code: "SCHOOL_DOMAIN_REQUIRED",
              message: SCHOOL_DOMAIN_REQUIRED_MESSAGE,
            })
          }
        },
      },
    },
    user: {
      update: {
        before: async (data) => {
          if (typeof data.name !== "string") return
          return { data: { ...data, name: normalizeDisplayName(data.name) } }
        },
      },
      create: {
        before: async (rawUser, context) => {
          // Store the trimmed name: the before-hook only validates it, so
          // "Lea" plus thousands of spaces would otherwise be persisted.
          const user = { ...rawUser, name: normalizeDisplayName(rawUser.name) }
          const role = deriveSchoolRole(user.email)
          const privacy = privacyAcceptanceFields(context)

          // genericOAuth registers only microsoft-entra-id, and its tenant is
          // pinned to the school's GUID above, so reaching this path means the
          // account was just authenticated by the school's directory.
          const viaSchoolTenant = isSchoolTenantCallback(context)

          // Microsoft sign-in is only meant for the school's Entra ID tenant,
          // so an account that doesn't match either school domain shape is rejected.
          if (viaSchoolTenant && !role) {
            throw new APIError("FORBIDDEN", {
              code: "SCHOOL_DOMAIN_REQUIRED",
              message: SCHOOL_DOMAIN_REQUIRED_MESSAGE,
            })
          }

          if (role) {
            // SSO accounts are verified by the school tenant. Keyed on the
            // callback path, never on the email domain alone; password
            // sign-ups still verify by mail.
            return {
              data: {
                ...user,
                ...privacy,
                role,
                ...(viaSchoolTenant ? { emailVerified: true } : {}),
              },
            }
          }

          if (privacy) return { data: { ...user, ...privacy } }
          if (user.name !== rawUser.name) return { data: user }
        },
        after: async (user, context) => {
          const acceptedAt = (user as { privacyAcceptedAt?: Date | null })
            .privacyAcceptedAt
          if (!acceptedAt) return
          const headers = context?.headers ?? context?.request?.headers
          // Lazy like ./email above: lib/audit pulls in @sentry/nextjs,
          // which every importer of this module would otherwise load.
          const { createAuditLog } = await import("./audit")
          await createAuditLog({
            action: PRIVACY_ACCEPTED_AUDIT_ACTION,
            entityType: "User",
            entityId: user.id,
            userId: user.id,
            metadata: {
              version: (user as { privacyPolicyVersion?: string | null })
                .privacyPolicyVersion,
              method: isSchoolTenantCallback(context) ? "sso" : "form",
            },
            ipAddress: headers ? getClientIp({ headers }) : null,
            userAgent: headers?.get("user-agent") ?? null,
          })
        },
      },
    },
  },
  plugins: [
    // Only registered when Microsoft login is configured. Redirect URI in
    // Entra ID: <base>/api/auth/callback/microsoft-entra-id.
    ...(microsoftLoginConfigured
      ? [
          genericOAuth({
            config: [
              microsoftEntraId({
                // Non-null: microsoftLoginConfigured implies the tenant
                // check above ran and accepted a GUID.
                clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
                clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
                tenantId: microsoftTenantId!,
                // better-auth 1.7 redirects signOut() to Entra's discovered
                // end_session_endpoint, which ends the Microsoft session for
                // the whole browser (Outlook, Teams, ...). Logging out of
                // OpenExam should only end the OpenExam session.
                disableProviderLogout: true,
              }),
            ],
          }),
        ]
      : []),
    passkey({
      rpID,
      rpName: "OpenExam",
    }),
    // Self-hosted Cap captcha. Uses the "cloudflare-turnstile" provider
    // because Cap matches its JSON wire format (not hCaptcha's).
    ...(process.env.DISABLE_CAPTCHA === "true" &&
    (process.env.NODE_ENV !== "production" || process.env.CI === "true")
      ? []
      : [
          captcha({
            provider: "cloudflare-turnstile",
            secretKey: process.env.CAP_SECRET_KEY ?? "",
            siteVerifyURLOverride: process.env.CAP_SITEVERIFY_URL,
          }),
        ]),
    // SEB auto-login token, redeemed by app/exam/[id]/seb-enter/route.ts.
    // expiresIn (minutes) must not drop below LAUNCH_TOKEN_TTL_SECONDS.
    oneTimeToken({
      storeToken: "hashed",
      expiresIn: LAUNCH_TOKEN_TTL_SECONDS / 60,
    }),
  ],
})
