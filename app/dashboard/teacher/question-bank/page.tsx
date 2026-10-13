import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { PageHeader } from "@/components/dashboard/page-header"
import { BankList } from "@/components/question-bank/bank-list"
import { loadQuestionBankSearchParams } from "@/lib/search-params/question-bank"
import {
  buildQuestionBankOrderBy,
  buildQuestionBankWhere,
  fetchQuestionBankPage,
  QUESTION_BANK_SORT_FIELDS,
} from "@/lib/question-bank-query"

export const metadata: Metadata = {
  title: "Fragenbank — OpenExam",
}

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function QuestionBankPage({ searchParams }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN") {
    redirect("/unauthorized")
  }

  const { page, type, folderId, q, sortBy, sortDir } =
    await loadQuestionBankSearchParams(searchParams)
  const limit = 25

  const validatedSortBy = QUESTION_BANK_SORT_FIELDS.includes(sortBy as never)
    ? (sortBy as (typeof QUESTION_BANK_SORT_FIELDS)[number])
    : undefined

  const where = buildQuestionBankWhere({
    creatorId: session.user.id,
    type,
    folderId,
    q,
  })

  const [{ items, total }, folders] = await Promise.all([
    fetchQuestionBankPage(
      where,
      page,
      limit,
      buildQuestionBankOrderBy(
        validatedSortBy,
        (sortDir as "asc" | "desc") ?? undefined
      )
    ),
    prisma.folder.findMany({
      where: { creatorId: session.user.id },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ])

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <PageHeader
        title="Fragenbank"
        description="Wiederverwendbare Fragen für mehrere Prüfungen"
      />

      <BankList items={items} total={total} limit={limit} folders={folders} />
    </div>
  )
}
