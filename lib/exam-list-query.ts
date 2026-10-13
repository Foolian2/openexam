import { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { examStatusSchema } from "@/lib/validators/exam"

export const EXAM_LIST_SELECT = {
  id: true,
  title: true,
  status: true,
  timeLimitMin: true,
  accessCode: true,
  scheduledStart: true,
  folderId: true,
  showResults: true,
  _count: { select: { questions: true } },
} satisfies Prisma.ExamSelect

export type ExamListItem = Prisma.ExamGetPayload<{ select: typeof EXAM_LIST_SELECT }> & {
  totalPoints: number
}

export interface ExamListFilters {
  creatorId: string
  status?: string
  q?: string
  folderId?: string
}

export function buildExamListWhere({ creatorId, status, q, folderId }: ExamListFilters): {
  where: Prisma.ExamWhereInput
  statusValid: boolean
} {
  const parsedStatus = status ? examStatusSchema.safeParse(status) : null
  const search = q?.trim()

  return {
    where: {
      creatorId,
      ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
      ...(folderId ? { folderId } : {}),
    },
    statusValid: parsedStatus?.success ?? !status,
  }
}

export async function fetchExamListPage(
  where: Prisma.ExamWhereInput,
  page: number,
  limit: number
): Promise<{ exams: ExamListItem[]; total: number }> {
  const [exams, total] = await Promise.all([
    prisma.exam.findMany({
      where,
      select: EXAM_LIST_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.exam.count({ where }),
  ])

  const pointsByExam = await prisma.question.groupBy({
    by: ["examId"],
    where: { examId: { in: exams.map((e) => e.id) } },
    _sum: { points: true },
  })
  const pointsMap = new Map(pointsByExam.map((p) => [p.examId, p._sum.points ?? 0]))

  return {
    exams: exams.map((e) => ({ ...e, totalPoints: pointsMap.get(e.id) ?? 0 })),
    total,
  }
}
