import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { createExamSchema, examStatusSchema } from "@/lib/validators/exam"
import { generateAccessCode } from "@/lib/access-code"
import { Prisma } from "@/generated/prisma/client"
import { buildExamListWhere, fetchExamListPage } from "@/lib/exam-list-query"
import { validationError } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1"))
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("limit") ?? "20"))
  )
  const statusParam = searchParams.get("status") ?? undefined
  if (statusParam && !examStatusSchema.safeParse(statusParam).success) {
    return validationError("Ungültiger Status")
  }

  const { where } = buildExamListWhere({
    creatorId: session.user.id,
    status: statusParam,
    q: searchParams.get("q") ?? undefined,
    folderId: searchParams.get("folder") ?? undefined,
  })

  const { exams, total } = await fetchExamListPage(where, page, limit)

  return NextResponse.json({ exams, total, page, limit })
}

export async function POST(request: NextRequest) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, BODY_LIMITS.MEDIUM)
  if (body instanceof NextResponse) return body
  const parsed = createExamSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  let exam = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      exam = await prisma.exam.create({
        data: {
          ...parsed.data,
          accessCode: generateAccessCode(),
          creatorId: session.user.id,
        },
      })
      break
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        attempt < 4
      )
        continue
      throw e
    }
  }

  await createAuditLog({
    action: "EXAM_CREATED",
    entityType: "Exam",
    entityId: exam!.id,
    examId: exam!.id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ exam }, { status: 201 })
}
