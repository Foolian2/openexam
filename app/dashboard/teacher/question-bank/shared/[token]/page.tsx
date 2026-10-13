import type { Metadata } from "next"
import Link from "next/link"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { ArrowLeft } from "lucide-react"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SharedItemActions } from "@/components/question-bank/shared-item-actions"
import { QUESTION_TYPE_LABELS } from "@/lib/constants/question-types"

export const metadata: Metadata = {
  title: "Geteilte Frage — OpenExam",
}

interface Props {
  params: Promise<{ token: string }>
}

export default async function SharedBankItemPage({ params }: Props) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) redirect("/login")
  // Staff only: this page renders the item's full config (answer keys, hidden
  // test cases). A student holding a share link must not see solutions.
  if (session.user.role !== "TEACHER" && session.user.role !== "ADMIN")
    redirect("/unauthorized")

  const { token } = await params
  const item = await prisma.questionBankItem.findUnique({
    where: { shareToken: token },
    select: {
      id: true,
      type: true,
      title: true,
      points: true,
      required: true,
      config: true,
      creatorId: true,
      creator: { select: { name: true } },
    },
  })

  if (!item) redirect("/dashboard/teacher/question-bank")

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <div className="flex items-start gap-2">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label="Zurück zur Fragenbank"
        >
          <Link
            href="/dashboard/teacher/question-bank"
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <p className="text-sm text-muted-foreground">
            Geteilte Frage von {item.creator.name}
          </p>
          <h1 className="text-xl font-semibold">
            {item.title || "(Ohne Titel)"}
          </h1>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">
          {QUESTION_TYPE_LABELS[item.type] ?? item.type}
        </Badge>
        <Badge variant="secondary">{item.points} Pkt.</Badge>
        {item.required && <Badge variant="outline">Pflichtfrage</Badge>}
      </div>

      <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs whitespace-pre-wrap">
        {JSON.stringify(item.config, null, 2)}
      </pre>

      <SharedItemActions
        token={token}
        isOwn={item.creatorId === session.user.id}
      />
    </div>
  )
}
