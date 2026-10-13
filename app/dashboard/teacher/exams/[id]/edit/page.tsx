import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { asTypedQuestion } from "@/lib/types/questions"
import { ExamEditor } from "@/components/exams/exam-editor"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

export const metadata: Metadata = {
  title: "Prüfung bearbeiten — OpenExam",
}

interface Props {
  params: Promise<{ id: string }>
}

export default async function EditExamPage({ params }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN")
    redirect("/unauthorized")

  const { id } = await params
  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam || exam.creatorId !== session.user.id) notFound()

  const questions = await prisma.question.findMany({
    where: { examId: id },
    orderBy: { order: "asc" },
  })

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/dashboard/teacher">
                Prüfungen
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{exam.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <ExamEditor
        exam={{
          ...exam,
          description: exam.description,
          scheduledStart: exam.scheduledStart?.toISOString() ?? null,
          scheduledEnd: exam.scheduledEnd?.toISOString() ?? null,
        }}
        initialQuestions={questions.map(asTypedQuestion)}
      />
    </div>
  )
}
