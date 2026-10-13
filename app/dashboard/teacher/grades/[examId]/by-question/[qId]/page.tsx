import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect, notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { QuestionGrader } from "@/components/grading/question-grader"

export const metadata: Metadata = {
  title: "Frage bewerten — OpenExam",
}

type Params = { params: Promise<{ examId: string; qId: string }> }

export default async function QuestionGraderPage({ params }: Params) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const { examId, qId } = await params
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    select: { id: true, creatorId: true },
  })
  if (!exam || exam.creatorId !== session.user.id) notFound()

  const question = await prisma.question.findUnique({
    where: { id: qId },
    select: { id: true, examId: true },
  })
  if (!question || question.examId !== examId) notFound()

  return <QuestionGrader examId={examId} questionId={qId} />
}
