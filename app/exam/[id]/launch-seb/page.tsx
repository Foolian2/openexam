import type { Metadata } from "next"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { ShieldCheck, Download } from "lucide-react"
import { auth } from "@/lib/auth"
import { loginRedirectUrl } from "@/lib/login-redirect"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { canLaunchSeb } from "@/lib/seb-issuance"
import {
  mintLaunchToken,
  LAUNCH_TOKEN_TTL_SECONDS,
} from "@/lib/seb-launch-token"
import { sebBaseUrl } from "@/lib/seb-urls"
import { SebLaunchRefresher } from "@/components/exam-taking/seb-launch-refresher"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Safe Exam Browser starten — OpenExam",
}

type Params = { params: Promise<{ id: string }> }

export default async function LaunchSEBPage({ params }: Params) {
  const { id } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect(loginRedirectUrl(`/exam/${id}/launch-seb`))

  const exam = await prisma.exam.findUnique({
    where: { id },
    select: { id: true, title: true, sebRequired: true },
  })
  if (!exam) redirect("/dashboard/student")
  if (!exam.sebRequired) redirect(`/exam/${id}/take`)

  // Both gates run before any token state is written: an unenrolled caller
  // must not be able to fill Redis with launch tokens for exams they cannot
  // enter, and an enrolled one must not be able to mint them without bound.
  // Eligibility is the same rule config issuance applies.
  if (!(await canLaunchSeb(id, session.user.id))) redirect("/dashboard/student")
  const limit = await rateLimit(
    `seb-launch:${session.user.id}`,
    30,
    300,
    "closed"
  )
  if (!limit.allowed) return <LaunchRateLimited />

  const baseUrl = sebBaseUrl()
  // seb:// tells SEB to fetch the config over http, sebs:// over https. Picking
  // the wrong one is fatal: sebs:// against an http dev server fails the TLS
  // handshake ("bad protocol version") and SEB terminates instead of launching.
  const sebScheme = new URL(baseUrl).protocol === "https:" ? "sebs" : "seb"
  // SEB makes a brand-new cookieless GET when it resolves the seb://${url}
  // handoff, so the session cookie can't authenticate the fetch. Mint a
  // short-TTL, single-use launch token here (the user is authenticated in this
  // render) and carry it in the URL as ?lt=. The seb-config endpoint accepts
  // it as an alternative to the session cookie. See lib/seb-launch-token.ts.
  const launchToken = await mintLaunchToken({
    userId: session.user.id,
    examId: id,
  })
  // Rides alongside `lt` so the seb-config route can bake it into the
  // personalized config's startURL, handing SEB's cookieless first request a
  // session instead of a login form. See app/exam/[id]/seb-enter/route.ts.
  //
  // Best-effort: if minting fails the launch still works, it just lands the
  // student on /login inside SEB — the behaviour before auto-login existed.
  let ott: string | null = null
  try {
    ott = (await auth.api.generateOneTimeToken({ headers: await headers() }))
      .token
  } catch {
    ott = null
  }
  const sebsUrl =
    `${baseUrl.replace(/^https?:\/\//, `${sebScheme}://`)}/api/exams/${id}/seb-config?lt=${launchToken}` +
    (ott ? `&ott=${encodeURIComponent(ott)}` : "")

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <SebLaunchRefresher ttlSeconds={LAUNCH_TOKEN_TTL_SECONDS} />
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <CardTitle>Safe Exam Browser erforderlich</CardTitle>
          <CardDescription>
            Die Prüfung «{exam.title}» kann nur im Safe Exam Browser (SEB)
            abgelegt werden. Starte SEB über den Button unten — die Prüfung
            öffnet sich automatisch.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button asChild>
            <a href={sebsUrl}>
              <ShieldCheck className="h-4 w-4" />
              Prüfung im SEB starten
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={`/api/exams/${id}/seb-config`} download>
              <Download className="h-4 w-4" />
              SEB-Konfiguration herunterladen
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            SEB ist nicht installiert? Lade es kostenlos auf{" "}
            <a
              href="https://safeexambrowser.org"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              safeexambrowser.org
            </a>{" "}
            herunter.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function LaunchRateLimited() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Zu viele Versuche</CardTitle>
          <CardDescription>
            Der Safe-Exam-Browser-Start wurde zu oft angefordert. Bitte warte
            einige Minuten und lade die Seite dann neu.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
