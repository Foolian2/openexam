/**
 * Per-IP sign-up limit (requests per 10 minutes) for better-auth's
 * customRules in lib/auth.ts: 40, except in CI. ci.yml's E2E job registers
 * ~50 accounts from one address within minutes and raises the limit through
 * SIGN_UP_RATE_LIMIT_MAX. Honored only when CI=true, like DISABLE_CAPTCHA,
 * so a production deployment cannot loosen it by accident.
 */
export function signUpPerIpMax(
  env: Record<string, string | undefined> = process.env
): number {
  const override = Number(env.SIGN_UP_RATE_LIMIT_MAX)
  if (env.CI === "true" && Number.isInteger(override) && override > 0) {
    return override
  }
  return 40
}
