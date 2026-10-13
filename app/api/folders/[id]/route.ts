import { NextRequest, NextResponse } from "next/server"
import { readBoundedJson, BODY_LIMITS } from "@/lib/body-size"
import { formatZodError } from "@/lib/utils"
import { requireStaff } from "@/lib/api-auth"
import { prisma } from "@/lib/prisma"
import { getClientIp } from "@/lib/client-ip"
import { createAuditLog } from "@/lib/audit"
import { createFolderSchema } from "@/lib/validators/folder"
import { Prisma } from "@/generated/prisma/client"
import { conflict, notFound, validationError } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

async function getOwnedFolder(folderId: string, userId: string) {
  const folder = await prisma.folder.findUnique({ where: { id: folderId } })
  if (!folder) return null
  if (folder.creatorId !== userId) return null
  return folder
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const folder = await getOwnedFolder(id, session.user.id)
  if (!folder) return notFound("Ordner nicht gefunden")

  const body = await readBoundedJson(request, BODY_LIMITS.TINY)
  if (body instanceof NextResponse) return body
  const parsed = createFolderSchema.safeParse(body)
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error))
  }

  let updated
  try {
    updated = await prisma.folder.update({
      where: { id },
      data: { name: parsed.data.name },
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
    action: "FOLDER_RENAMED",
    entityType: "Folder",
    entityId: id,
    userId: session.user.id,
    metadata: { name: parsed.data.name },
    ipAddress: getClientIp(request) ?? undefined,
  })

  return NextResponse.json({ folder: updated })
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authed = await requireStaff(request)
  if (authed instanceof NextResponse) return authed
  const session = authed

  const { id } = await params
  const folder = await getOwnedFolder(id, session.user.id)
  if (!folder) return notFound("Ordner nicht gefunden")

  await prisma.folder.delete({ where: { id } })

  await createAuditLog({
    action: "FOLDER_DELETED",
    entityType: "Folder",
    entityId: id,
    userId: session.user.id,
    ipAddress: getClientIp(request) ?? undefined,
  })

  return new NextResponse(null, { status: 204 })
}
