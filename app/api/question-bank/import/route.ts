import { randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { z } from "zod"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { verifyOrigin } from "@/lib/csrf"
import { createQuestionSchema } from "@/lib/validators/question"
import { validationError } from "@/lib/api-response"

// Items are validated individually below so that one bad entry reports as a
// per-index failure instead of rejecting the whole payload.
const importSchema = z.object({
  items: z
    .array(z.unknown())
    .min(1, "Mindestens eine Frage erforderlich")
    .max(100, "Maximal 100 Fragen pro Import"),
})

interface ImportFailure {
  index: number
  error: string
}

/**
 * Bulk-imports bank items. Each item is validated with the same per-type
 * schema as the create route; invalid items are reported per-index while the
 * valid ones are created in a single transaction (all-or-nothing per item,
 * not per request).
 */
export async function POST(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, BODY_LIMITS.LARGE)
  if (body instanceof NextResponse) return body
  const parsed = importSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  const failures: ImportFailure[] = []
  const valid: z.infer<typeof createQuestionSchema>[] = []
  parsed.data.items.forEach((item, index) => {
    const result = createQuestionSchema.safeParse(item)
    if (result.success) valid.push(result.data)
    else failures.push({ index, error: formatZodError(result.error) })
  })

  const created =
    valid.length > 0
      ? await prisma.questionBankItem.createManyAndReturn({
          data: valid.map((item) => ({
            type: item.type as never,
            title: item.title,
            points: item.points,
            required: item.required,
            config: item.config as never,
            creatorId: session.user.id,
          })),
        })
      : []

  // Bulk operation: one audit row for the whole import, not one per item.
  await createAuditLog({
    action: "QUESTION_BANK_IMPORT",
    entityType: "QuestionBankItem",
    entityId: created[0]?.id ?? randomUUID(),
    userId: session.user.id,
    metadata: {
      total: parsed.data.items.length,
      created: created.length,
      failed: failures.length,
    },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json(
    { created: created.length, failed: failures },
    { status: failures.length > 0 && created.length === 0 ? 422 : 201 }
  )
}
