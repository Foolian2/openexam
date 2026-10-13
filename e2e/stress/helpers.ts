import { expect, type APIRequestContext } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
  type SeededExam,
} from "../helpers"

export { uniqueEmail, signUp, promoteToTeacher, createActiveExam }
export type { SeededExam }

// Better Auth rejects cross-origin POSTs to /api/*, so this must match the
// origin the requests actually go to: the local dev server by default, or the
// remote deployment when TARGET_BASE_URL points the suite at one.
const ORIGIN_HEADER = {
  origin: new URL(
    process.env.E2E_BASE_URL ??
      process.env.TARGET_BASE_URL ??
      `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
  ).origin,
}

export interface JoinedSession {
  sessionId: string
  examId: string
  questionId: string
}

// The join route stages first-time entries: past the configured admissions
// rate it answers 202 `{ queued: true, waitMs }` and reserves a place in line
// instead of creating a session (lib/exam-admission.ts). 202 is a 2xx, so a
// bare `ok()` check sails past it and the undefined sessionId only surfaces
// one request later as a baffling 404 — hence waiting it out here, the way
// the join form does. A single student joining their own exam is rank 1 and
// never waits at all; this only engages once a spec drives a real cohort.
const MAX_JOIN_ATTEMPTS = 5

export async function joinExamSession(
  student: APIRequestContext,
  accessCode: string,
  headers: Record<string, string> = ORIGIN_HEADER
): Promise<{ sessionId: string; examId: string }> {
  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt++) {
    const res = await student.post("/api/sessions", {
      headers,
      data: { accessCode },
    })
    expect(res.ok(), `join failed: ${res.status()} ${await res.text()}`).toBe(
      true
    )
    const body = await res.json()
    if (!body.queued) return { sessionId: body.sessionId, examId: body.examId }
    await new Promise((resolve) =>
      setTimeout(resolve, Number(body.waitMs) || 0)
    )
  }
  throw new Error(
    `join still queued after ${MAX_JOIN_ATTEMPTS} attempts — is EXAM_ADMISSION_RATE_PER_SEC far below this spec's join rate?`
  )
}

export async function joinExam(
  student: APIRequestContext,
  accessCode: string
): Promise<JoinedSession> {
  const { sessionId, examId } = await joinExamSession(student, accessCode)

  const takeRes = await student.get(`/api/sessions/${sessionId}`)
  expect(takeRes.ok(), `session load failed: ${await takeRes.text()}`).toBe(
    true
  )
  const { questions } = await takeRes.json()

  return {
    sessionId,
    examId,
    questionId: (questions as { id: string }[])[0].id,
  }
}

export async function saveAnswer(
  student: APIRequestContext,
  sessionId: string,
  questionId: string
): Promise<void> {
  const res = await student.put(`/api/sessions/${sessionId}/answers`, {
    data: {
      questionId,
      content: { type: "MULTIPLE_CHOICE", selectedOptionIds: ["opt-bern"] },
    },
  })
  expect(res.ok(), `answer save failed: ${await res.text()}`).toBe(true)
}

export async function submitExam(
  student: APIRequestContext,
  sessionId: string
): Promise<void> {
  const res = await student.post(`/api/sessions/${sessionId}/submit`, {
    data: { idempotencyKey: crypto.randomUUID() },
  })
  expect(
    res.ok() || res.status() === 409,
    `submit failed: ${await res.text()}`
  ).toBe(true)
}

export async function extendSession(
  teacher: APIRequestContext,
  sessionId: string,
  minutes: number
): Promise<void> {
  const res = await teacher.post(`/api/sessions/${sessionId}/extend`, {
    data: { minutes },
  })
  expect(res.ok(), `extend failed: ${await res.text()}`).toBe(true)
}

export async function teacherExportCsv(
  teacher: APIRequestContext,
  examId: string
): Promise<string> {
  const res = await teacher.get(`/api/exams/${examId}/export`)
  expect(res.ok(), `export failed: ${await res.text()}`).toBe(true)
  return res.text()
}

/** Parse the semicolon-delimited export, including escaped quotes/newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const input = text.replace(/^\uFEFF/, "")
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = !quoted
    } else if (!quoted && char === ";") {
      row.push(cell)
      cell = ""
    } else if (!quoted && (char === "\n" || char === "\r")) {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
      if (char === "\r" && input[i + 1] === "\n") i++
    } else cell += char
  }
  if (cell.length || row.length) rows.push([...row, cell])
  return rows
}

export function cloneAuthenticatedContext(
  playwright: typeof import("@playwright/test").request,
  source: APIRequestContext,
  baseURL: string
): Promise<APIRequestContext> {
  return source
    .storageState()
    .then((state) => playwright.newContext({ baseURL, storageState: state }))
}
