import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { PageHeader } from "@/components/dashboard/page-header"
import { PersonalSettings } from "@/components/settings/personal-settings"

export const metadata: Metadata = {
  title: "Einstellungen — OpenExam",
}

export default async function StudentSettingsPage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "STUDENT") redirect("/unauthorized")

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Einstellungen"
        description="Verwalten Sie Ihr Konto und Ihre Darstellung."
      />
      <PersonalSettings
        userId={session.user.id}
        name={session.user.name}
        email={session.user.email}
        callbackURL="/dashboard/student/settings"
      />
    </div>
  )
}
