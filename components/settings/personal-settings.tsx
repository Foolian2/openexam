import { prisma } from "@/lib/prisma"
import { ProfileForm } from "@/components/settings/profile-form"
import { EmailForm } from "@/components/settings/email-form"
import { PasswordForm } from "@/components/settings/password-form"
import { AccessibilitySettings } from "@/components/settings/accessibility-settings"
import { verifiedEmailChange } from "@/lib/email-change-state"

interface PersonalSettingsProps {
  userId: string
  name: string
  email: string
  callbackURL: string
  // Raw signed email-change parameter from the page's query string (see
  // lib/email-change-state.ts); verified here against userId.
  emailChange?: string | string[]
  // Whether this user ever sits an exam. Only the exam-timer preference is
  // exam-specific; false hides that one toggle.
  //
  // Deliberately not a switch on the whole accessibility card: OpenDyslexic,
  // high contrast and reduced motion are applied dashboard-wide for every
  // role by AccessibilityProvider (app/dashboard/layout.tsx), and this card
  // holds the only controls for them. Hiding it outright would leave a
  // teacher who had turned one on with no way to turn it off again — the
  // users least able to work around it.
  takesExams?: boolean
}

export async function PersonalSettings({
  userId,
  name,
  email,
  callbackURL,
  emailChange,
  takesExams = true,
}: PersonalSettingsProps) {
  const credentialAccount = await prisma.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { id: true },
  })

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <ProfileForm initialName={name} />
      <EmailForm
        currentEmail={email}
        callbackURL={callbackURL}
        requestedEmail={verifiedEmailChange(emailChange, userId)}
      />
      <PasswordForm hasPassword={!!credentialAccount} />
      <AccessibilitySettings showExamTimerPref={takesExams} />
    </div>
  )
}
