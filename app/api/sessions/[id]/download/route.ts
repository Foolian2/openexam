import { NextRequest, NextResponse } from "next/server"
import { resolveAnswerFile } from "@/lib/answer-file-access"
import { answerFileExists } from "@/lib/answer-files"
import { notFound } from "@/lib/api-response"

type Params = { params: Promise<{ id: string }> }

/**
 * Returns `{ url }` for a FILE_UPLOAD answer's file, for the owning student
 * or the exam's teacher. The response contract is unchanged from when this
 * handed out a MinIO presigned URL — only the URL now points at
 * `/download/file` on this origin — so a client loaded before a deploy and a
 * replica still on the old build both keep working mid-rollout.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { id } = await params
  const resolved = await resolveAnswerFile(request, id)
  if (resolved instanceof NextResponse) return resolved

  // Check here, not only in /download/file: a missing file should surface as
  // this route's JSON 404 in the page, not as an error in a new tab.
  if (!(await answerFileExists(resolved.fileKey, id, resolved.questionId))) {
    return notFound("Keine Datei gefunden")
  }

  const url = `/api/sessions/${encodeURIComponent(id)}/download/file?questionId=${encodeURIComponent(resolved.questionId)}`
  return NextResponse.json({ url })
}
