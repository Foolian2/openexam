import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { readBoundedJson } from "@/lib/body-size"
import { verifyOrigin } from "@/lib/csrf"
import { validationError } from "@/lib/api-response"

const updateOnboardingSchema = z.object({ dismissed: z.boolean() })

export async function PATCH(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, 1024)
  if (body instanceof NextResponse) return body

  const parsed = updateOnboardingSchema.safeParse(body)
  if (!parsed.success) {
    return validationError("Ungültige Anfrage")
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { onboardingDismissed: parsed.data.dismissed },
  })

  return NextResponse.json({ dismissed: parsed.data.dismissed })
}
