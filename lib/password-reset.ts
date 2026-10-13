import { prisma } from "@/lib/prisma"
import { logDebug, logError } from "@/lib/logger"

/**
 * better-auth `emailAndPassword.sendResetPassword` (PRODUCT-RISK-DECISIONS
 * R3b). `logOnly` is true where no mailbox exists (development, CI): the link
 * is logged instead of mailed, like the verification email.
 */
export async function sendResetPasswordEmail(
  {
    user,
    url: defaultUrl,
    token,
  }: {
    user: { id: string; email: string; name: string }
    url: string
    token: string
  },
  logOnly: boolean
): Promise<void> {
  // SSO-only accounts (Microsoft) have no password; better-auth would create
  // a credential account on reset, giving them a password login that bypasses
  // the identity provider. Send nothing, silently, so the response still
  // doesn't reveal which kind of account exists.
  const credential = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  })
  if (!credential) return
  // Link straight to the reset page with the token in the QUERY, not
  // better-auth's /api/auth/reset-password/<token>: nginx logs $uri, which
  // would put a live reset credential in the access log. The page also sets
  // no-referrer so its asset requests don't carry it in a Referer.
  const url = `${new URL(defaultUrl).origin}/reset-password?token=${encodeURIComponent(token)}`
  if (logOnly) {
    logDebug("Reset password link", { email: user.email, url })
    return
  }
  const { sendEmail } = await import("./email")
  await sendEmail({
    to: user.email,
    subject: "OpenExam — Passwort zurücksetzen",
    text: `Hallo ${user.name},\n\ndu hast angefordert, dein OpenExam-Passwort zurückzusetzen. Der Link ist 30 Minuten gültig und kann nur einmal verwendet werden:\n${url}\n\nFalls du das nicht angefordert hast, ignoriere diese E-Mail — dein Passwort bleibt unverändert.`,
  })
}

/**
 * The better-auth hook itself: starts the lookup and delivery in the
 * background and returns at once. Awaiting it would make
 * /request-password-reset slower (and fail on SMTP errors) only for addresses
 * with a password account — a timing and error oracle for which accounts
 * exist. better-auth's docs recommend not awaiting the email for this reason.
 */
export function scheduleResetPasswordEmail(
  data: Parameters<typeof sendResetPasswordEmail>[0],
  logOnly: boolean
): Promise<void> {
  void sendResetPasswordEmail(data, logOnly).catch((err) => {
    logError("password reset email failed", {
      userId: data.user.id,
      err: err instanceof Error ? err.message : String(err),
    })
  })
  return Promise.resolve()
}
