import { expect, type APIRequestContext } from "@playwright/test"

// Shared fixture password for accounts this suite creates and throws away in
// a disposable database. Not a credential for any real account or service.
// nosemgrep: openexam-hardcoded-credential
export const PASSWORD = "e2e-Passwort-123"

// Better Auth rejects cross-origin (or origin-less) POSTs; API-level calls
// must present the app's own origin like a browser would.
// Must match the port playwright.config.ts starts the dev server on.
export const ORIGIN_HEADER = {
  origin: new URL(
    process.env.E2E_BASE_URL ??
      process.env.TARGET_BASE_URL ??
      `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
  ).origin,
}

/** Unique per-run email so tests can re-run against the same database. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`
}

/**
 * Retries a Better Auth API call on 429s using its `X-Retry-After` response
 * header (exact seconds until the shared IP-keyed rate-limit window resets).
 * Needed because multiple spec files still share one rate-limit budget even
 * with a single Playwright worker if their calls land in the same window.
 */
async function withRateLimitRetry(
  makeRequest: () => Promise<import("@playwright/test").APIResponse>
): Promise<import("@playwright/test").APIResponse> {
  const maxAttempts = 5
  let res = await makeRequest()
  for (
    let attempt = 1;
    res.status() === 429 && attempt < maxAttempts;
    attempt++
  ) {
    const retryAfterSeconds = Number(res.headers()["x-retry-after"] ?? 5)
    await new Promise((resolve) =>
      setTimeout(resolve, (retryAfterSeconds + 1) * 1000)
    )
    res = await makeRequest()
  }
  return res
}

/**
 * Registers a user via the Better Auth API. In development mode email
 * verification is skipped and sign-up also signs the user in, so the
 * request context (and any browser context sharing it) ends up with a
 * valid session cookie.
 */
export async function signUp(
  request: APIRequestContext,
  opts: { name: string; email: string; password?: string }
): Promise<void> {
  const res = await withRateLimitRetry(() =>
    request.post("/api/auth/sign-up/email", {
      headers: ORIGIN_HEADER,
      data: {
        name: opts.name,
        email: opts.email,
        password: opts.password ?? PASSWORD,
        // Required by lib/auth.ts for every password sign-up.
        acceptPrivacy: true,
      },
    })
  )
  expect(res.ok(), `sign-up failed: ${res.status()} ${await res.text()}`).toBe(
    true
  )
}

/**
 * Promotes the signed-in user to TEACHER using the shared access code, then
 * signs out and back in — the session cookie caches the role, so the old
 * session would still act as STUDENT (the register-teacher UI does the
 * re-auth server-side in /api/teacher/promote instead; the sign-out/sign-in
 * here mirrors that effect for the API context).
 */
export async function promoteToTeacher(
  request: APIRequestContext,
  creds: { email: string; password?: string }
): Promise<void> {
  const res = await request.post("/api/teacher/promote", {
    headers: ORIGIN_HEADER,
    data: {
      // better-auth normalizes the stored email to lowercase on sign-up, and
      // the route re-authenticates against the session user's exact address.
      email: creds.email.toLowerCase(),
      password: creds.password ?? PASSWORD,
      accessCode: process.env.TEACHER_ACCESS_CODE ?? "dev-teacher-code",
    },
  })
  expect(res.ok(), `promote failed: ${res.status()} ${await res.text()}`).toBe(
    true
  )

  await request.post("/api/auth/sign-out", { headers: ORIGIN_HEADER })
  const signInRes = await withRateLimitRetry(() =>
    request.post("/api/auth/sign-in/email", {
      headers: ORIGIN_HEADER,
      data: { email: creds.email, password: creds.password ?? PASSWORD },
    })
  )
  expect(signInRes.ok(), `re-sign-in failed: ${await signInRes.text()}`).toBe(
    true
  )
}

export interface SeededExam {
  id: string
  accessCode: string
}

/**
 * Creates, fills, and activates an exam via the REST API as the signed-in
 * teacher: one multiple-choice question (correct option: "Bern") and one
 * free-text question. Returns the exam id and student access code.
 */
export async function createActiveExam(
  request: APIRequestContext,
  title: string,
  schedule?: { scheduledStart: string; scheduledEnd: string },
  options?: { withFileUpload?: boolean }
): Promise<SeededExam> {
  const exam = await createPublishedExam(request, title, schedule, options)

  const activateRes = await request.post(`/api/exams/${exam.id}/activate`)
  expect(activateRes.ok(), `activate failed: ${await activateRes.text()}`).toBe(
    true
  )

  return exam
}

/**
 * Like createActiveExam, but stops at PUBLISHED: the state a shared-start
 * exam's waiting room is open in. `settings` is PATCHed while still a DRAFT.
 */
export async function createPublishedExam(
  request: APIRequestContext,
  title: string,
  settings?: Record<string, unknown>,
  options?: { withFileUpload?: boolean }
): Promise<SeededExam> {
  const createRes = await request.post("/api/exams", {
    data: { title, timeLimitMin: 30 },
  })
  expect(createRes.ok(), `exam create failed: ${await createRes.text()}`).toBe(
    true
  )
  const { exam } = await createRes.json()

  // Applied while the exam is still a DRAFT — an ACTIVE exam rejects edits.
  if (settings) {
    const settingsRes = await request.patch(`/api/exams/${exam.id}`, {
      headers: ORIGIN_HEADER,
      data: settings,
    })
    expect(
      settingsRes.ok(),
      `settings failed: ${await settingsRes.text()}`
    ).toBe(true)
  }

  const mcRes = await request.post(`/api/exams/${exam.id}/questions`, {
    data: {
      title: "Was ist die Hauptstadt der Schweiz?",
      points: 2,
      required: true,
      type: "MULTIPLE_CHOICE",
      config: {
        multiSelect: false,
        options: [
          { id: "opt-bern", text: "Bern", isCorrect: true },
          { id: "opt-zuerich", text: "Zürich", isCorrect: false },
          { id: "opt-genf", text: "Genf", isCorrect: false },
        ],
      },
    },
  })
  expect(mcRes.ok(), `MC question failed: ${await mcRes.text()}`).toBe(true)

  const ftRes = await request.post(`/api/exams/${exam.id}/questions`, {
    data: {
      title: "Begründe deine Antwort.",
      points: 3,
      required: false,
      type: "FREE_TEXT",
      config: { maxLength: 1000, richText: false },
    },
  })
  expect(ftRes.ok(), `free-text question failed: ${await ftRes.text()}`).toBe(
    true
  )

  if (options?.withFileUpload) {
    const fuRes = await request.post(`/api/exams/${exam.id}/questions`, {
      data: {
        title: "Lade deine Lösung hoch.",
        points: 1,
        required: false,
        type: "FILE_UPLOAD",
        config: {
          allowedExtensions: [".pdf", ".html"],
          maxFileSizeMB: 1,
          instructions: "",
        },
      },
    })
    expect(
      fuRes.ok(),
      `file-upload question failed: ${await fuRes.text()}`
    ).toBe(true)
  }

  const publishRes = await request.post(`/api/exams/${exam.id}/publish`)
  expect(publishRes.ok(), `publish failed: ${await publishRes.text()}`).toBe(
    true
  )

  return { id: exam.id, accessCode: exam.accessCode }
}
