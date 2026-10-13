import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { SessionGrader } from "@/components/grading/session-grader"
import { SUBMITTED_STATUSES } from "@/lib/session-state"

export const metadata: Metadata = {
  title: "Abgabe bewerten — OpenExam",
}

type Params = { params: Promise<{ examId: string; sessionId: string }> }

export default async function GradeSessionPage({ params }: Params) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const { examId, sessionId } = await params
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, creatorId: true },
  })
  if (!exam || exam.creatorId !== session.user.id) notFound()

  // Sibling submissions in the same order as the submissions table, for
  // prev/next navigation between students.
  const siblings = await prisma.examSession.findMany({
    where: { examId, status: { in: SUBMITTED_STATUSES } },
    select: { id: true },
    orderBy: { user: { name: "asc" } },
  })
  const index = siblings.findIndex((s) => s.id === sessionId)
  if (index === -1) notFound()

  return (
    <SessionGrader
      sessionId={sessionId}
      examId={examId}
      position={{ index: index + 1, total: siblings.length }}
      prevSessionId={index > 0 ? siblings[index - 1].id : null}
      nextSessionId={
        index < siblings.length - 1 ? siblings[index + 1].id : null
      }
    />
  )
}
