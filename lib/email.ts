import nodemailer, { type Transporter } from "nodemailer"

const globalForMailer = globalThis as unknown as { mailer: Transporter | null }

function createTransport(): Transporter | null {
  const host = process.env.SMTP_HOST
  if (!host) return null
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  })
}

const mailer = globalForMailer.mailer ?? createTransport()
if (process.env.NODE_ENV !== "production") globalForMailer.mailer = mailer

export async function sendEmail(options: {
  to: string
  subject: string
  text: string
  html?: string
}): Promise<void> {
  if (!mailer) {
    // Surface the misconfiguration instead of silently dropping the mail —
    // an unverifiable account is a locked-out account.
    throw new Error(
      "SMTP is not configured (set SMTP_HOST; optionally SMTP_PORT, SMTP_SECURE, and SMTP_USER/SMTP_PASSWORD for authenticated servers)"
    )
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM ?? "OpenExam <no-reply@openexam.local>",
    ...options,
  })
}
