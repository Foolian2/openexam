import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
import { PersonalSettings } from "@/components/settings/personal-settings"
import { SettingsSection } from "@/components/settings/settings-section"
import { UserManagementTable } from "@/components/settings/user-management-table"
import { loadUserManagementSearchParams } from "@/lib/search-params/user-management"

export const metadata: Metadata = {
  title: "Einstellungen — OpenExam",
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AdminSettingsPage({ searchParams }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "ADMIN") redirect("/unauthorized")

  const { page: requestedPage, q } =
    await loadUserManagementSearchParams(searchParams)
  const limit = 20
  const search = q?.trim()

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
        ],
      }
    : {}

  const total = await prisma.user.count({ where })
  const totalPages = Math.max(1, Math.ceil(total / limit))
  const page = Math.min(requestedPage, totalPages)

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      emailVerified: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * limit,
    take: limit,
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Einstellungen"
        description="Verwalten Sie Ihr Konto und die Benutzer."
      />
      <PersonalSettings
        userId={session.user.id}
        name={session.user.name}
        email={session.user.email}
        callbackURL="/dashboard/admin/settings"
        takesExams={false}
      />
      <SettingsSection
        title="Benutzerverwaltung"
        description="Benutzer suchen und Rollen verwalten."
      >
        <UserManagementTable
          users={users.map((user) => ({
            ...user,
            createdAt: user.createdAt.toISOString(),
          }))}
          total={total}
          limit={limit}
          currentUserId={session.user.id}
        />
      </SettingsSection>
    </div>
  )
}
