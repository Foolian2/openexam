import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { loginRedirectUrl } from "@/lib/login-redirect"
import { prisma } from "@/lib/prisma"
import { verifySebAccess, isSEBUserAgent } from "@/lib/seb-guard"
import { waitPath, waitUrl } from "@/lib/seb-urls"
import { isSubmitted, isWaiting } from "@/lib/session-state"
import { WaitingRoom } from "@/components/exam-taking/waiting-room"
import { AccessibilityProvider } from "@/components/accessibility-provider"

export const metadata: Metadata = {
  title: "Warteraum — OpenExam",
}

type Params = { params: Promise<{ id: string }> }

/**
 * Waiting room of a shared-start exam (Exam.waitingRoom). The student sits
 * here, inside SEB when the exam requires it, until the teacher presses
 * Start; the client then counts down to the shared start and moves on to
 * /take.
 */
export default async function WaitingRoomPage({ params }: Params) {
  const { id } = await params
  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders })
  // Same reasoning as the take page: inside SEB there is no address bar.
  if (!session) redirect(loginRedirectUrl(waitPath(id)))
  if (session.user.role !== "STUDENT") redirect("/unauthorized")

  const exam = await prisma.exam.findUnique({ where: { id } })
  if (!exam) redirect("/dashboard/student")

  const examSession = await prisma.examSession.findUnique({
    where: { examId_userId: { examId: id, userId: session.user.id } },
  })
  if (!examSession) redirect("/dashboard/student")
  if (isSubmitted(examSession.status)) redirect(`/exam/${id}/complete`)

  const waiting = isWaiting(examSession.status) && exam.status === "PUBLISHED"
  const countingDown =
    exam.status === "ACTIVE" &&
    !isWaiting(examSession.status) &&
    examSession.startedAt !== null &&
    examSession.startedAt > new Date()
  if (!waiting && !countingDown) {
    // Already started: the exam. A waiting session under any other exam
    // state (closed or archived before Start) has nothing to wait for.
    redirect(
      exam.status === "ACTIVE" && !isWaiting(examSession.status)
        ? `/exam/${id}/take`
        : "/dashboard/student"
    )
  }

  if (exam.sebRequired) {
    // The same nudge-then-verify as the take page, against this page's URL.
    const token = requestHeaders.get("x-safeexambrowser-configkeyhash")
    if (token) {
      const guard = await verifySebAccess({
        exam,
        examSession,
        headers: requestHeaders,
        requestUrl: waitUrl(id),
        isNavigation: true,
      })
      if (!guard.ok) redirect(`/exam/${id}/launch-seb`)
    } else if (!isSEBUserAgent(requestHeaders.get("user-agent") ?? "")) {
      redirect(`/exam/${id}/launch-seb`)
    }
  }

  // The same preferences as the take page: the wait can be long, and SEB
  // starts with a fresh browser that has none of the client-side state.
  return (
    <AccessibilityProvider
      initialPrefs={{
        dyslexicFont: !!session.user.dyslexicFont,
        highContrast: !!session.user.highContrast,
        reducedMotion: !!session.user.reducedMotion,
        hideExamTimer: !!session.user.hideExamTimer,
      }}
    >
      <WaitingRoom
        sessionId={examSession.id}
        examId={exam.id}
        title={exam.title}
        timeLimitMin={exam.timeLimitMin}
        initialStartedAt={examSession.startedAt?.toISOString() ?? null}
        initialServerNow={new Date().toISOString()}
      />
    </AccessibilityProvider>
  )
}
