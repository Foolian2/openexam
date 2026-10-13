import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { LiveMonitor } from "@/components/monitor/live-monitor"
import { SebQuitPassword } from "@/components/monitor/seb-quit-password"

export const metadata: Metadata = {
  title: "Live-Monitor — OpenExam",
}

type Params = { params: Promise<{ examId: string }> }

export default async function MonitorExamPage({ params }: Params) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const { examId } = await params
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: {
      id: true,
      creatorId: true,
      sebRequired: true,
      sebQuitPassword: true,
    },
  })
  if (!exam || exam.creatorId !== session.user.id) notFound()

  // Only this boolean crosses into the client component's props — the
  // plaintext itself is never serialized here. This page is routinely on a
  // projector, and its server-rendered payload/view-source is reachable to
  // anyone with page access; SebQuitPassword fetches the plaintext on demand
  // instead, only once the teacher clicks reveal.
  const hasQuitPassword = Boolean(exam.sebQuitPassword)

  return (
    <div className="flex flex-col gap-6 p-6">
      <LiveMonitor examId={examId} />
      {exam.sebRequired && hasQuitPassword && (
        <SebQuitPassword examId={examId} />
      )}
    </div>
  )
}
