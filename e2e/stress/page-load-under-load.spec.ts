import { test, expect, request, type Browser } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"
import { joinExamSession } from "./helpers"

/**
 * Measures the one performance target nothing else in this repo checks:
 * "exam page load < 2s (p95)" from README.md's performance table. The k6
 * suite measures the REST and WebSocket protocol paths; only a real browser
 * measures the thing a student actually waits for — server render, JS parse,
 * hydration and first paint.
 *
 * Run it twice to get the number that matters:
 *   1. against an idle server, for the baseline
 *   2. again while a k6 scenario (load/) holds N students on the same box
 * The delta between the two is what capacity costs the user experience.
 *
 *   TARGET_BASE_URL=https://exam.lan PAGE_LOAD_SAMPLES=5 pnpm test:stress \
 *     page-load-under-load
 *
 * Auth: reuses the pre-signed session cookies scripts/load-seed.ts writes, for
 * the same two reasons k6 does (load/lib/auth.js) — the sign-in endpoint is
 * rate-limited 5/60s per IP, and real sign-in sessions live only in Redis
 * where ws-backend can't see them. Seeding runs on the server, so copy the
 * files over first:
 *
 *   scp root@exam.lan:/opt/openexam/load/data/seed-*.json load/data/
 */

const SAMPLES = Number(process.env.PAGE_LOAD_SAMPLES ?? 5)
const BASE_URL =
  process.env.E2E_BASE_URL ??
  process.env.TARGET_BASE_URL ??
  `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
const TARGET_P95_MS = Number(process.env.PAGE_LOAD_TARGET_MS ?? 2000)

// Better Auth prefixes its cookie with `__Secure-` when the base URL is https
// (useSecureCookies defaults to on there). Against an HTTPS deployment the
// unprefixed name authenticates nothing and every request 401s.
const SESSION_COOKIE_NAME = BASE_URL.startsWith("https://")
  ? "__Secure-better-auth.session_token"
  : "better-auth.session_token"

interface SeedUser {
  email: string
  sessionCookie: string
}

function readSeed(file: string): SeedUser[] {
  const full = path.join(process.cwd(), "load", "data", file)
  if (!fs.existsSync(full)) {
    throw new Error(
      `${full} not found — run "pnpm load:seed" on the server and copy ` +
        `load/data/seed-*.json here. See this spec's header comment.`
    )
  }
  return JSON.parse(fs.readFileSync(full, "utf8"))
}

function cookieFor(user: SeedUser) {
  const url = new URL(BASE_URL)
  return {
    name: SESSION_COOKIE_NAME,
    value: user.sessionCookie,
    domain: url.hostname,
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "Lax" as const,
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest-rank; with SAMPLES in the single digits this is the honest
  // reading — an interpolated p95 over 5 points would invent precision.
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.max(0, rank - 1)]
}

test.describe("exam page load under load", () => {
  test.describe.configure({ mode: "serial" })

  test(`exam take page loads within ${TARGET_P95_MS}ms p95`, async ({ browser }) => {
    test.setTimeout(300_000)

    const students = readSeed("seed-users.json")
    const teachers = readSeed("seed-teachers.json")
    expect(students.length, "no seeded students").toBeGreaterThan(0)
    expect(teachers.length, "no seeded teachers").toBeGreaterThan(0)

    // Students used here must NOT be the ones a concurrent k6 run is driving,
    // or the two fight over the same session and ws-backend evicts one with
    // SESSION_REPLACED. k6 assigns from the front of the list, so take from
    // the back.
    const probes = students.slice(-SAMPLES)
    expect(
      probes.length,
      `need at least ${SAMPLES} seeded students, have ${students.length}`
    ).toBe(SAMPLES)

    const teacherApi = await request.newContext({
      baseURL: BASE_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        origin: BASE_URL,
        cookie: `${SESSION_COOKIE_NAME}=${teachers[0].sessionCookie}`,
      },
    })

    const exam = await createProbeExam(teacherApi)
    const navigations: number[] = []
    const lcps: number[] = []

    for (const probe of probes) {
      const studentApi = await request.newContext({
        baseURL: BASE_URL,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          origin: BASE_URL,
          cookie: `${SESSION_COOKIE_NAME}=${probe.sessionCookie}`,
        },
      })
      // Empty headers: this context already carries `origin: BASE_URL`, and
      // the helper's own default would be the local dev origin.
      await joinExamSession(studentApi, exam.accessCode, {})
      await studentApi.dispose()

      const { navigationMs, lcpMs } = await measurePageLoad(browser, probe, exam.id)
      navigations.push(navigationMs)
      if (lcpMs !== null) lcps.push(lcpMs)
      console.log(
        `student ${probe.email}: nav ${navigationMs.toFixed(0)}ms` +
          (lcpMs !== null ? `, LCP ${lcpMs.toFixed(0)}ms` : "")
      )
    }

    await teacherApi.dispose()

    const navP95 = percentile(navigations, 95)
    const lcpP95 = lcps.length ? percentile(lcps, 95) : null
    console.log(
      `\nsamples=${navigations.length} nav p95=${navP95.toFixed(0)}ms` +
        (lcpP95 !== null ? ` lcp p95=${lcpP95.toFixed(0)}ms` : "") +
        `\nnav all: ${navigations.map((n) => n.toFixed(0)).join(", ")}`
    )

    expect(navP95, `exam page load p95 exceeded ${TARGET_P95_MS}ms`).toBeLessThan(
      TARGET_P95_MS
    )
  })
})

async function createProbeExam(api: import("@playwright/test").APIRequestContext) {
  const createRes = await api.post("/api/exams", {
    data: { title: `page-load probe ${Date.now()}`, timeLimitMin: 30 },
  })
  expect(createRes.ok(), `exam create failed: ${await createRes.text()}`).toBe(true)
  const { exam } = await createRes.json()

  const questionRes = await api.post(`/api/exams/${exam.id}/questions`, {
    data: {
      title: "Hauptstadt der Schweiz?",
      points: 2,
      required: true,
      type: "MULTIPLE_CHOICE",
      config: {
        multiSelect: false,
        options: [
          { id: "opt-bern", text: "Bern", isCorrect: true },
          { id: "opt-zuerich", text: "Zürich", isCorrect: false },
        ],
      },
    },
  })
  expect(questionRes.ok(), `question create failed: ${await questionRes.text()}`).toBe(true)

  expect((await api.post(`/api/exams/${exam.id}/publish`)).ok()).toBe(true)
  expect((await api.post(`/api/exams/${exam.id}/activate`)).ok()).toBe(true)

  return { id: exam.id as string, accessCode: exam.accessCode as string }
}

async function measurePageLoad(browser: Browser, probe: SeedUser, examId: string) {
  // A fresh context per sample: a warm HTTP cache would measure the browser,
  // not the server, and the point is what a student hits on first load.
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies([cookieFor(probe)])
  const page = await context.newPage()

  // Register the LCP observer before navigating, or the entry is missed.
  await page.addInitScript(() => {
    ;(window as unknown as { __lcp: number | null }).__lcp = null
    new PerformanceObserver((list) => {
      const entries = list.getEntries()
      ;(window as unknown as { __lcp: number | null }).__lcp =
        entries[entries.length - 1].startTime
    }).observe({ type: "largest-contentful-paint", buffered: true })
  })

  await page.goto(`/exam/${examId}/take`, { waitUntil: "load" })

  const navigationMs = await page.evaluate(() => {
    const [nav] = performance.getEntriesByType(
      "navigation"
    ) as PerformanceNavigationTiming[]
    return nav ? nav.loadEventEnd - nav.startTime : performance.now()
  })

  // LCP is only final once the page settles; a short settle beats a racy read.
  await page.waitForTimeout(1000)
  const lcpMs = await page.evaluate(
    () => (window as unknown as { __lcp: number | null }).__lcp
  )

  await context.close()
  return { navigationMs, lcpMs }
}
