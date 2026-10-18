import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { verifyOrigin } from "@/lib/csrf"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { createFolderSchema } from "@/lib/validators/folder"
import { Prisma } from "@/generated/prisma/client"
import { conflict, validationError } from "@/lib/api-response"

export async function GET(request: NextRequest) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const folders = await prisma.folder.findMany({
    where: { creatorId: session.user.id },
    include: { _count: { select: { exams: true } } },
    orderBy: { name: "asc" },
  })

  return NextResponse.json({ folders })
}

export async function POST(request: NextRequest) {
  const originError = verifyOrigin(request)
  if (originError) return originError

  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = createFolderSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  let folder
  try {
    folder = await prisma.folder.create({
      data: { name: parsed.data.name, creatorId: session.user.id },
    })
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      return conflict("Ordner mit diesem Namen existiert bereits")
    }
    throw e
  }

  await createAuditLog({
    action: "FOLDER_CREATED",
    entityType: "Folder",
    entityId: folder.id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ folder }, { status: 201 })
}
