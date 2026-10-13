import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { verifySebAccess, isSEBUserAgent } from "@/lib/seb-guard"
import { takeUrl, waitPath } from "@/lib/seb-urls"
import { ExamRunner } from "@/components/exam-taking/exam-runner"
import { AccessibilityProvider } from "@/components/accessibility-provider"
import { isSubmitted, isWaiting } from "@/lib/session-state"

export const metadata: Metadata = {
  title: "Prüfung — OpenExam",
}

type Params = { params: Promise<{ id: string }> }

export default async function TakeExamPage({ params }: Params) {
  const { id } = await params
  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders })
  // Same reasoning as proxy.ts: inside SEB there is no address bar to get back
  // here with, so the login has to return the student to the exam itself.
  if (!session) redirect(`/login?next=/exam/${id}/take`)
  if (session.user.role !== "STUDENT") redirect("/unauthorized")

  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam) redirect("/dashboard/student")

  const examSession = await prisma.examSession.findUnique({
    where: { examId_userId: { examId: id, userId: session.user.id } },
  })
  // Joining happens via access code on the dashboard; deep links without a
  // session go back there.
  if (!examSession) redirect("/dashboard/student")
  if (isSubmitted(examSession.status)) {
    redirect(`/exam/${id}/complete`)
  }
  // Shared start: before the clock begins (still in the waiting room, or in
  // the countdown after Start) the waiting room is the page to be on.
  if (
    isWaiting(examSession.status) ||
    (examSession.startedAt && examSession.startedAt > new Date())
  ) {
    redirect(waitPath(id))
  }
  if (exam.status !== "ACTIVE") redirect(`/exam/${id}/complete`)

  if (exam.sebRequired) {
    const token = requestHeaders.get("x-safeexambrowser-configkeyhash")
    if (token) {
      // A token is present — this is either Windows' native per-URL header
      // or a client that already resolved the key via the JS API and is
      // navigating with it attached. Either way, validate it for real.
      const requestUrl = takeUrl(id)
      const guard = await verifySebAccess({
        exam,
        examSession,
        headers: requestHeaders,
        requestUrl,
        // A navigation, not a sebFetch: it cannot carry the Browser Exam Key
        // header, and reporting that absence would flag a plain page reload as
        // "SEB nicht mehr gesendet". See isNavigation in lib/seb-guard.ts.
        isNavigation: true,
      })
      if (!guard.ok) redirect(`/exam/${id}/launch-seb`)
    } else if (!isSEBUserAgent(requestHeaders.get("user-agent") ?? "")) {
      // No token and not even a SEB-looking User-Agent: almost certainly a
      // plain browser. This is a UX nudge, not the security boundary — SEB
      // on macOS/iOS runs in a WKWebView that cannot send this header on
      // *any* request, including this very first page load, so the actual
      // enforcement happens per-request against /api/sessions/* and the WS
      // handshake once the client resolves a key via the SEB JS API.
      redirect(`/exam/${id}/launch-seb`)
    }
  }

  return (
    <AccessibilityProvider
      initialPrefs={{
        dyslexicFont: !!session.user.dyslexicFont,
        highContrast: !!session.user.highContrast,
        reducedMotion: !!session.user.reducedMotion,
        hideExamTimer: !!session.user.hideExamTimer,
      }}
    >
      <ExamRunner
        sessionId={examSession.id}
        examId={exam.id}
        sebRequired={exam.sebRequired}
      />
    </AccessibilityProvider>
  )
}
