import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
import { PersonalSettings } from "@/components/settings/personal-settings"
import { PasskeySettings } from "@/components/settings/passkey-settings"
import { SettingsSection } from "@/components/settings/settings-section"
import { AutoArchiveToggle } from "@/components/settings/auto-archive-toggle"

export const metadata: Metadata = {
  title: "Einstellungen — OpenExam",
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function SettingsPage({ searchParams }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN")
    redirect("/unauthorized")

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { autoArchiveEnabled: true },
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Einstellungen"
        description="Verwalten Sie Ihr Konto und Ihre Einstellungen."
      />
      <PersonalSettings
        userId={session.user.id}
        name={session.user.name}
        email={session.user.email}
        callbackURL="/dashboard/teacher/settings"
        emailChange={(await searchParams).emailChange}
        takesExams={false}
      />
      <div className="max-w-2xl">
        <SettingsSection
          title="Automatische Archivierung"
          description="Halten Sie Ihre Prüfungsverwaltung aufgeräumt."
        >
          <AutoArchiveToggle
            initialEnabled={user?.autoArchiveEnabled ?? false}
          />
        </SettingsSection>
      </div>
      <div className="max-w-2xl">
        <PasskeySettings />
      </div>
    </div>
  )
}
