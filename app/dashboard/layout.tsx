import { headers } from "next/headers"
import { Suspense } from "react"

import { AccessibilityProvider } from "@/components/accessibility-provider"
import { LoginRedirect } from "@/components/auth/login-redirect"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session) return <LoginRedirect />

  const isStudent = session.user.role === "STUDENT"
  const folders = isStudent
    ? []
    : await prisma.folder.findMany({
        where: { creatorId: session.user.id },
        include: { _count: { select: { exams: true } } },
        orderBy: { name: "asc" },
      })

  return (
    <SidebarProvider>
      <AccessibilityProvider
        initialPrefs={{
          dyslexicFont: !!session.user.dyslexicFont,
          highContrast: !!session.user.highContrast,
          reducedMotion: !!session.user.reducedMotion,
          hideExamTimer: !!session.user.hideExamTimer,
        }}
      >
        <Suspense>
          <AppSidebar
            role={session.user.role as string}
            userName={session.user.name ?? ""}
            userEmail={session.user.email ?? ""}
            folders={folders}
          />
        </Suspense>
        <SidebarInset>{children}</SidebarInset>
      </AccessibilityProvider>
    </SidebarProvider>
  )
}
