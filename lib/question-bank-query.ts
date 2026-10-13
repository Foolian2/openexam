import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

export const QUESTION_BANK_SELECT = {
  id: true,
  type: true,
  title: true,
  points: true,
  required: true,
  folderId: true,
  createdAt: true,
  updatedAt: true,
  // Needed by the share dialog so the UI knows whether a link is already
  // live without an extra round-trip per row.
  shareToken: true,
  // Number of copies in exams that could still receive a propagated edit
  // (DRAFT/PUBLISHED only). Drives the propagate-after-edit prompt.
  _count: {
    select: {
      usedBy: {
        where: { exam: { status: { in: ["DRAFT", "PUBLISHED"] } } },
      },
    },
  },
} satisfies Prisma.QuestionBankItemSelect

export type QuestionBankListItem = Prisma.QuestionBankItemGetPayload<{
  select: typeof QUESTION_BANK_SELECT
}>

export const QUESTION_BANK_SORT_FIELDS = [
  "updatedAt",
  "createdAt",
  "title",
  "points",
  "type",
] as const
export type QuestionBankSortField = (typeof QUESTION_BANK_SORT_FIELDS)[number]

export type QuestionBankSortDir = "asc" | "desc"

export interface QuestionBankFilters {
  creatorId: string
  type?: string
  folderId?: string
  q?: string
  sortBy?: QuestionBankSortField
  sortDir?: QuestionBankSortDir
}

export function buildQuestionBankWhere({
  creatorId,
  type,
  folderId,
  q,
}: QuestionBankFilters): Prisma.QuestionBankItemWhereInput {
  const search = q?.trim()
  return {
    creatorId,
    ...(type ? { type: type as never } : {}),
    ...(folderId ? { folderId } : {}),
    ...(search
      ? { title: { contains: search, mode: "insensitive" as const } }
      : {}),
  }
}

/**
 * Maps validated sort params to a Prisma orderBy. Sort keys come from the
 * whitelist above (never raw query params), so arbitrary field sorting or
 * direction injection is impossible.
 */
export function buildQuestionBankOrderBy(
  sortBy?: QuestionBankSortField,
  sortDir?: QuestionBankSortDir
): Prisma.QuestionBankItemOrderByWithRelationInput {
  const field =
    sortBy && QUESTION_BANK_SORT_FIELDS.includes(sortBy) ? sortBy : "updatedAt"
  const dir = sortDir === "asc" ? "asc" : "desc"
  return { [field]: dir } as Prisma.QuestionBankItemOrderByWithRelationInput
}

export async function fetchQuestionBankPage(
  where: Prisma.QuestionBankItemWhereInput,
  page: number,
  limit: number,
  orderBy: Prisma.QuestionBankItemOrderByWithRelationInput = {
    updatedAt: "desc",
  }
): Promise<{ items: QuestionBankListItem[]; total: number }> {
  const [items, total] = await Promise.all([
    prisma.questionBankItem.findMany({
      where,
      select: QUESTION_BANK_SELECT,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.questionBankItem.count({ where }),
  ])
  return { items, total }
}
