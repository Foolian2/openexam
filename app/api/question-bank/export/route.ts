import { NextRequest, NextResponse } from "next/server"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import {
  buildQuestionBankWhere,
  QuestionBankFilters,
} from "@/lib/question-bank-query"

/**
 * Paginated export of the caller's bank items honoring the same filters as
 * the list endpoint, but including `config` so the output round-trips through
 * POST /api/question-bank/import.
 */
export async function GET(request: NextRequest) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const params = request.nextUrl.searchParams
  const parsedPage = parseInt(params.get("page") ?? "1")
  const page = Math.max(1, Number.isNaN(parsedPage) ? 1 : parsedPage)
  const limit = 100

  const where = buildQuestionBankWhere({
    creatorId: session.user.id,
    type: params.get("type") ?? undefined,
    folderId: params.get("folderId") ?? undefined,
    q: params.get("q") ?? undefined,
  } satisfies QuestionBankFilters)

  const [items, total] = await Promise.all([
    prisma.questionBankItem.findMany({
      where,
      select: {
        id: true,
        type: true,
        title: true,
        points: true,
        required: true,
        config: true,
      },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.questionBankItem.count({ where }),
  ])

  return NextResponse.json({ items, total, page, limit })
}
