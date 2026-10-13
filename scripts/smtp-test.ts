/**
 * Sends one test email through the configured SMTP server, so a wrong
 * password or blocked port shows up at install time instead of when the
 * first teacher never receives their verification mail. `./openexam
 * install` runs it after the stack is up; `./openexam doctor --smtp` runs it
 * on demand.
 *
 * Builds the transport from the same variables, with the same defaults, as
 * lib/email.ts's createTransport — a test that configured SMTP differently
 * from the app would prove nothing.
 *
 * Runs inside the `migrate` image (it has nodemailer and outbound network
 * via the `edge` network), with the script bind-mounted like
 * scripts/seed-demo.ts:
 *
 *   docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
 *     --no-deps -v "$PWD/scripts/smtp-test.ts:/app/scripts/smtp-test.ts:ro" \
 *     -e SMTP_HOST -e SMTP_PORT -e SMTP_SECURE -e SMTP_USER -e SMTP_PASSWORD -e SMTP_FROM \
 *     migrate pnpm tsx scripts/smtp-test.ts admin@example.ch
 *
 * Exit 0: sent. Exit 1: connection/auth/send failed (reason on stderr).
 * Exit 2: usage error or SMTP_HOST unset.
 */
import nodemailer from "nodemailer"

async function main() {
  const to = process.argv[2]
  if (!to || !to.includes("@")) {
    console.error("usage: smtp-test.ts <recipient@example.com>")
    process.exit(2)
  }
  const host = process.env.SMTP_HOST
  if (!host) {
    console.error("SMTP_HOST is not set — nothing to test.")
    process.exit(2)
  }

  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  })

  try {
    await transport.verify()
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM ?? "OpenExam <no-reply@openexam.local>",
      to,
      subject: "OpenExam: SMTP test",
      text:
        "This is a test message from your OpenExam installation.\n\n" +
        "If you can read it, email verification and password resets will work.\n",
    })
    console.log(
      `Sent test email to ${to} (${info.messageId ?? "no message id"}).`
    )
  } catch (error) {
    const e = error as { code?: string; response?: string; message?: string }
    console.error(
      `SMTP test failed: ${[e.code, e.response ?? e.message].filter(Boolean).join(" — ")}`
    )
    process.exit(1)
  }
}

main()
