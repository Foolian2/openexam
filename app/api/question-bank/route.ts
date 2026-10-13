import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { verifyOrigin } from "@/lib/csrf"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { createQuestionSchema } from "@/lib/validators/question"
import {
  buildQuestionBankOrderBy,
  buildQuestionBankWhere,
  fetchQuestionBankPage,
  QUESTION_BANK_SORT_FIELDS,
} from "@/lib/question-bank-query"
import { validationError } from "@/lib/api-response"

/** Lists the caller's question bank items, paginated and filterable by type/folder/title, sortable via a whitelisted sortBy/sortDir. */
export async function GET(request: NextRequest) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const params = request.nextUrl.searchParams
  const page = Math.max(1, parseInt(params.get("page") ?? "1"))
  const limit = 25

  const sortBy = params.get("sortBy") ?? undefined
  const sortDir = params.get("sortDir") ?? undefined
  const validatedSortBy = QUESTION_BANK_SORT_FIELDS.includes(sortBy as never)
    ? (sortBy as (typeof QUESTION_BANK_SORT_FIELDS)[number])
    : undefined

  const where = buildQuestionBankWhere({
    creatorId: session.user.id,
    type: params.get("type") ?? undefined,
    folderId: params.get("folderId") ?? undefined,
    q: params.get("q") ?? undefined,
  })
  const { items, total } = await fetchQuestionBankPage(
    where,
    page,
    limit,
    buildQuestionBankOrderBy(
      validatedSortBy,
      (sortDir as "asc" | "desc") ?? undefined
    )
  )

  return NextResponse.json({ items, total, page, limit })
}

/** Creates a reusable question bank item, validated per-type like a regular question. */
export async function POST(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, BODY_LIMITS.MEDIUM)
  if (body instanceof NextResponse) return body
  const parsed = createQuestionSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const { type, config, title, points, required } = parsed.data as {
    type: string
    config: unknown
    title: string
    points: number
    required: boolean
  }

  const item = await prisma.questionBankItem.create({
    data: {
      type: type as never,
      config: config as never,
      title,
      points,
      required,
      creatorId: session.user.id,
    },
  })

  await createAuditLog({
    action: "QUESTION_BANK_ITEM_CREATED",
    entityType: "QuestionBankItem",
    entityId: item.id,
    userId: session.user.id,
    metadata: { type },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ item }, { status: 201 })
}
