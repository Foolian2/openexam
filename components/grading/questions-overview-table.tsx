"use client"

import Link from "next/link"
import { ListChecks, PenLine } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { QUESTION_TYPE_LABELS } from "@/lib/constants/question-types"
import type { QuestionType } from "@/generated/prisma/client"

interface QuestionRow {
  id: string
  title: string
  type: QuestionType
  points: number
  gradedCount: number
  reviewedCount: number
}

interface Props {
  examId: string
  totalSessions: number
  questions: QuestionRow[]
}

// Auto-gradable types accumulate a "reviewed" count worth showing; manual
// types (FREE_TEXT, FILE_UPLOAD, CODE) never get autoGraded rows, so the
// column would always read 0 there — hide it to avoid implying otherwise.
const AUTO_GRADABLE_TYPES: QuestionType[] = [
  "MULTIPLE_CHOICE",
  "FILL_IN_THE_BLANK",
  "MATCHING",
  "TRUE_FALSE",
  "SHORT_ANSWER",
  "ORDERING",
]

export function QuestionsOverviewTable({
  examId,
  totalSessions,
  questions,
}: Props) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Frage</TableHead>
            <TableHead>Typ</TableHead>
            <TableHead>Bewertet</TableHead>
            <TableHead>Überprüft</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {questions.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="p-0">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <ListChecks />
                    </EmptyMedia>
                    <EmptyTitle>Noch keine Fragen</EmptyTitle>
                    <EmptyDescription>
                      Diese Prüfung enthält keine Fragen — fügen Sie im
                      Prüfungseditor Fragen hinzu, um nach Frage zu bewerten.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          )}
          {questions.map((q) => {
            const fullyGraded =
              totalSessions > 0 && q.gradedCount >= totalSessions
            return (
              <TableRow key={q.id}>
                <TableCell className="max-w-xs truncate font-medium">
                  {q.title}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {QUESTION_TYPE_LABELS[q.type]}
                </TableCell>
                <TableCell className="tabular-nums">
                  <Badge
                    variant={fullyGraded ? "default" : "secondary"}
                    className={
                      fullyGraded
                        ? "bg-success text-success-foreground hover:bg-success/90"
                        : undefined
                    }
                  >
                    {q.gradedCount} / {totalSessions}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground tabular-nums">
                  {AUTO_GRADABLE_TYPES.includes(q.type)
                    ? `${q.reviewedCount} überprüft`
                    : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button asChild size="sm" variant="outline">
                    <Link
                      href={`/dashboard/teacher/grades/${examId}/by-question/${q.id}`}
                    >
                      <PenLine className="h-4 w-4" />
                      Bewerten
                    </Link>
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
