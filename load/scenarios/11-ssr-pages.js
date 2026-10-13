// Server-side rendering under load — the one hot path the rest of this suite
// never touches.
//
// Every other scenario hits JSON API routes. Those are cheap: parse, query,
// serialize. An HTML page request is a different cost profile entirely — the
// App Router renders an async server component tree, awaits its data, streams
// the document, and serializes the RSC flight payload for hydration. On a
// CPU-bound box that is the most plausible place for a web-tier bottleneck to
// hide, and until now nothing measured it at scale.
//
// This complements, rather than replaces, e2e/stress/page-load-under-load.spec.ts:
// k6 executes no JavaScript, so it measures the SERVER's cost and how it
// saturates; Playwright measures what a student's browser experiences (parse,
// hydrate, LCP) at n=5. Saturation and experience are different questions.
//
//   k6 run load/scenarios/11-ssr-pages.js -e CLASSES=8 -e PAGE_RATE=50
// Requires: pnpm load:seed -- --count <CLASSES*STUDENTS_PER_CLASS> --teachers <CLASSES>
//
// Executor is constant-arrival-rate, not ramping-vus: a page load is a
// one-shot request, so the meaningful load parameter is "renders per second",
// and arrival-rate executors keep issuing them even as the server slows.
// A VU-based executor would silently throttle itself the moment the server
// got slower — measuring the load generator's patience rather than the
// server's capacity.
import http from "k6/http"
import { check } from "k6"
import { Trend, Counter, Rate } from "k6/metrics"
import { BASE_URL, TLS_OPTIONS } from "../config.js"
import { authHeadersForUser } from "../lib/auth.js"
import { provisionClassrooms, roomForVU } from "../lib/room.js"

const CLASSES = Number(__ENV.CLASSES || 4)
const STUDENTS_PER_CLASS = Number(__ENV.STUDENTS_PER_CLASS || 25)
// Page loads per second, aggregate. A whole class arriving at the start of an
// exam is ~25 loads over a few seconds, so a school-wide start of 1600
// students across 10 minutes is ~3/s; 50/s models everyone arriving at once.
const PAGE_RATE = Number(__ENV.PAGE_RATE || 20)
const DURATION = __ENV.DURATION || "2m"
// Share of requests going to each page type. The exam take page is the one
// that matters; the dashboards are included because they are what students and
// teachers hit immediately before it, in the same burst.
const TAKE_SHARE = Number(__ENV.TAKE_SHARE || 0.7)
const STUDENT_DASH_SHARE = Number(__ENV.STUDENT_DASH_SHARE || 0.2)
// remainder -> teacher monitor

const STUDENTS = CLASSES * STUDENTS_PER_CLASS

export const ssrTtfb = new Trend("ssr_ttfb", true)
export const ssrDuration = new Trend("ssr_duration", true)
export const ssrBytes = new Trend("ssr_bytes")
export const ssrCorrectPage = new Rate("ssr_correct_page")
export const ssrRedirected = new Counter("ssr_redirected")

export const options = {
  ...TLS_OPTIONS,
  setupTimeout: "30m",
  // Never follow redirects. TakeExamPage has five redirect() branches before
  // it renders anything — to /login, /unauthorized, /dashboard/student or
  // /exam/{id}/complete — and every one of them is a CHEAPER page. Following
  // them would produce excellent latency numbers for a page that was never
  // rendered. A redirect here is a failed measurement, so it must be visible.
  redirects: 0,
  scenarios: {
    ssr: {
      executor: "constant-arrival-rate",
      rate: PAGE_RATE,
      timeUnit: "1s",
      duration: DURATION,
      // Generously over-provisioned: an SSR request that takes 2s at
      // saturation occupies a VU for that whole time, and k6 drops iterations
      // (visible as dropped_iterations) rather than queueing if it runs out.
      preAllocatedVUs: Math.max(50, PAGE_RATE * 4),
      maxVUs: Math.max(200, PAGE_RATE * 20),
    },
  },
  thresholds: {
    // README's "exam page load < 2s (p95)" is a browser-side target; the
    // server's share of it should be a small fraction. Asserting the full
    // budget here is deliberately loose — it catches collapse, and the TTFB
    // trend carries the interesting signal.
    "ssr_duration{page:take}": ["p(95)<2000"],
    // Export-only, never meant to fail: k6 breaks a tagged sub-metric into the
    // summary ONLY if a threshold names it. Without these the first SSR ladder
    // exported one per-page series (take duration, which has a real threshold
    // above) and nothing else, so the reported TTFB was silently the all-pages
    // aggregate sitting in a column next to a take-only number.
    "ssr_ttfb{page:take}": ["p(95)<600000"],
    "ssr_ttfb{page:student_dash}": ["p(95)<600000"],
    "ssr_ttfb{page:monitor}": ["p(95)<600000"],
    "ssr_duration{page:student_dash}": ["p(95)<600000"],
    "ssr_duration{page:monitor}": ["p(95)<600000"],
    ssr_correct_page: ["rate>0.99"],
    ssr_redirected: ["count<1"],
    http_req_failed: ["rate<0.01"],
    // Arrival-rate executors drop iterations when maxVUs is exhausted. That
    // means the offered load was not actually delivered, so the latency
    // numbers describe a smaller test than the one requested.
    dropped_iterations: ["count<1"],
  },
}

export function setup() {
  return provisionClassrooms("ssr", {
    classes: CLASSES,
    studentsPerClass: STUDENTS_PER_CLASS,
  })
}

// Each page is identified by the <title> its metadata export sets. Checking
// the title rather than the status alone is what distinguishes "rendered the
// exam" from "rendered something else that also returned 200".
const PAGES = {
  take: { title: "Prüfung — OpenExam" },
  studentDash: { path: "/dashboard/student", title: "Schüler-Dashboard — OpenExam" },
  monitor: { title: "Live-Monitor — OpenExam" },
}

export default function ssrPages(data) {
  // Arrival-rate executors recycle VUs across a large pool, so __VU is not a
  // stable student identity here the way it is in the VU-based scenarios.
  // Pick a student at random instead; every one of them is pre-joined.
  const studentIndex = Math.floor(Math.random() * STUDENTS) + 1
  const assigned = roomForVU(data, studentIndex)
  if (!assigned) return

  const roll = Math.random()
  if (roll < TAKE_SHARE) {
    request(
      `/exam/${assigned.room.examId}/take`,
      authHeadersForUser(assigned.user),
      "take",
      PAGES.take.title
    )
  } else if (roll < TAKE_SHARE + STUDENT_DASH_SHARE) {
    request(
      PAGES.studentDash.path,
      authHeadersForUser(assigned.user),
      "student_dash",
      PAGES.studentDash.title
    )
  } else {
    const room = data.rooms[Math.floor(Math.random() * data.rooms.length)]
    request(
      `/dashboard/teacher/monitor?examId=${room.examId}`,
      room.teacherHeaders,
      "monitor",
      PAGES.monitor.title
    )
  }
}

function request(path, authHeaders, pageTag, expectedTitle) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: authHeaders,
    tags: { name: `ssr_${pageTag}`, page: pageTag },
  })

  // timings.waiting is TTFB — for a streamed response that is when the shell
  // arrives, while duration covers the whole document including the RSC
  // payload. The gap between them is the streaming/serialization cost, which
  // is the part an API-route benchmark can never show.
  ssrTtfb.add(res.timings.waiting, { page: pageTag })
  ssrDuration.add(res.timings.duration, { page: pageTag })
  ssrBytes.add(res.body ? res.body.length : 0, { page: pageTag })

  if (res.status >= 300 && res.status < 400) {
    ssrRedirected.add(1, { page: pageTag })
    ssrCorrectPage.add(false, { page: pageTag })
    console.error(
      `${pageTag}: redirected ${res.status} -> ${res.headers["Location"]} (measured nothing)`
    )
    return res
  }

  const body = res.body || ""
  const rendered = res.status === 200 && body.includes(expectedTitle)
  ssrCorrectPage.add(rendered, { page: pageTag })
  check(res, { [`${pageTag} rendered`]: () => rendered })
  if (!rendered && res.status === 200) {
    console.error(`${pageTag}: 200 but title missing — got ${body.slice(0, 120)}`)
  }
  return res
}
