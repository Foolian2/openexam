import { NextRequest, NextResponse } from "next/server"
import { resolveAnswerFile } from "@/lib/answer-file-access"
import { readAnswerFile } from "@/lib/answer-files"
import { downloadHeaders } from "@/lib/answer-file-headers"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Serves a FILE_UPLOAD answer's bytes — the URL `/download` hands out. Same
 * access checks as that route (resolveAnswerFile), then a forced download
 * that never renders on this origin (downloadHeaders).
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params
  const resolved = await resolveAnswerFile(request, id)
  if (resolved instanceof NextResponse) return resolved

  const data = await readAnswerFile(resolved.fileKey, id, resolved.questionId)
  if (!data) {
    return notFound("Keine Datei gefunden")
  }
  return new NextResponse(data, {
    status: 200,
    headers: downloadHeaders(resolved.fileName, data.byteLength),
  })
}
