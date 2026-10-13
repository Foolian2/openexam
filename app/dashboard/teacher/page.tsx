import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
import { ActiveExamCallout } from "@/components/exams/active-exam-callout"
import { ExamListTable } from "@/components/exams/exam-list-table"
import { NewExamDialog } from "@/components/exams/new-exam-dialog"
import { sweepAutoArchive } from "@/lib/auto-archive"
import { buildExamListWhere, fetchExamListPage } from "@/lib/exam-list-query"
import { loadExamListSearchParams } from "@/lib/search-params/exam-list"
import { ACTIVE_STATUSES } from "@/lib/session-state"
import {
  computeOnboardingSteps,
  fetchOnboardingActionExamIds,
  fetchOnboardingStats,
  onboardingComplete,
} from "@/lib/onboarding"
import {
  OnboardingChecklist,
  OnboardingShowButton,
} from "@/components/dashboard/onboarding-checklist"

export const metadata: Metadata = {
  title: "Prüfungsverwaltung — OpenExam",
  description:
    "Prüfungen verwalten, starten, überwachen und auswerten – OpenExam",
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function TeacherDashboardPage({ searchParams }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN")
    redirect("/unauthorized")

  const { page, status, q, folder } =
    await loadExamListSearchParams(searchParams)
  const limit = 20
  const search = q?.trim()

  const { where } = buildExamListWhere({
    creatorId: session.user.id,
    status,
    q: search,
    folderId: folder,
  })

  const userPrefs = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { autoArchiveEnabled: true, onboardingDismissed: true },
  })
  if (userPrefs?.autoArchiveEnabled) {
    await sweepAutoArchive(session.user.id)
  }

  const [
    { exams, total },
    statusCounts,
    activeExams,
    folders,
    onboardingStats,
    onboardingActionExamIds,
  ] = await Promise.all([
    fetchExamListPage(where, page, limit),
    prisma.exam.groupBy({
      by: ["status"],
      where: { creatorId: session.user.id },
      _count: { _all: true },
    }),
    prisma.exam.findMany({
      where: { creatorId: session.user.id, status: "ACTIVE" },
      select: {
        id: true,
        title: true,
        accessCode: true,
        activatedAt: true,
        _count: {
          select: {
            sessions: {
              where: { status: { in: ACTIVE_STATUSES } },
            },
          },
        },
      },
      orderBy: { activatedAt: "desc" },
    }),
    prisma.folder.findMany({
      where: { creatorId: session.user.id },
      orderBy: { name: "asc" },
    }),
    fetchOnboardingStats(session.user.id),
    fetchOnboardingActionExamIds(session.user.id),
  ])

  const onboardingSteps = computeOnboardingSteps(onboardingStats)
  const onboardingDone = onboardingComplete(onboardingSteps)
  const onboardingDismissed = userPrefs?.onboardingDismissed ?? false
  const showOnboarding = !onboardingDismissed && !onboardingDone

  const counts = Object.fromEntries(
    statusCounts.map((c) => [c.status, c._count._all])
  ) as Record<string, number>
  const totalAll = statusCounts.reduce((sum, c) => sum + c._count._all, 0)

  const serializedActiveExams = activeExams.map((e) => ({
    id: e.id,
    title: e.title,
    accessCode: e.accessCode,
    activatedAt: e.activatedAt?.toISOString() ?? null,
    initialActiveCount: e._count.sessions,
  }))

  const serializedExams = exams.map((e) => ({
    ...e,
    scheduledStart: e.scheduledStart?.toISOString() ?? null,
  }))

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Prüfungsverwaltung"
        description={`Willkommen, ${session.user.name}`}
        actions={
          <>
            {onboardingDismissed && !onboardingDone && (
              <OnboardingShowButton initialDismissed={onboardingDismissed} />
            )}
            <NewExamDialog />
          </>
        }
      />

      {serializedActiveExams.length > 0 && (
        <ActiveExamCallout exams={serializedActiveExams} />
      )}

      {showOnboarding && (
        <OnboardingChecklist
          steps={onboardingSteps}
          actionExamIds={onboardingActionExamIds}
        />
      )}

      <ExamListTable
        exams={serializedExams as never}
        total={total}
        limit={limit}
        counts={counts}
        totalAll={totalAll}
        folders={folders}
      />
    </div>
  )
}
