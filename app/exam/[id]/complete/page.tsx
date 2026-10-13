import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { CheckCircle2 } from "lucide-react"
import { auth } from "@/lib/auth"
import { loginRedirectUrl } from "@/lib/login-redirect"
import { prisma } from "@/lib/prisma"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export const metadata: Metadata = {
  title: "Prüfung abgeschlossen — OpenExam",
}

type Params = { params: Promise<{ id: string }> }

export default async function ExamCompletePage({ params }: Params) {
  const { id } = await params
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect(loginRedirectUrl(`/exam/${id}/complete`))

  const examSession = await prisma.examSession.findUnique({
    where: { examId_userId: { examId: id, userId: session.user.id } },
    include: { exam: { select: { title: true, sebRequired: true } } },
  })

  const inSeb = examSession?.exam.sebRequired ?? false

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <CheckCircle2 className="mx-auto mb-2 h-12 w-12 text-success" />
          <CardTitle>Prüfung abgeschlossen</CardTitle>
          <CardDescription>
            {examSession
              ? `Deine Antworten zu «${examSession.exam.title}» wurden gespeichert${examSession.submittedAt ? " und abgegeben" : ""}.`
              : "Diese Prüfung ist beendet."}{" "}
            {inSeb
              ? "Beende Safe Exam Browser über den Button unten."
              : "Du kannst dieses Fenster jetzt schliessen."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {inSeb ? (
            // A plain <a>, not next/link: SEB only notices the quit URL on a real
            // page load, and next/link would soft-navigate via pushState, which
            // SEB does not see.
            <Button asChild>
              <a href={`/exam/${id}/quit`}>Safe Exam Browser beenden</a>
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link href="/dashboard/student">Zum Dashboard</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
