import { prisma } from "@/lib/prisma"

export type OnboardingStepId =
  "create-exam" | "add-questions" | "publish" | "activate" | "grade"

export interface OnboardingStats {
  examCount: number
  examWithQuestionsCount: number
  publishedCount: number
  activatedCount: number
  gradedCount: number
}

export interface OnboardingStep {
  id: OnboardingStepId
  done: boolean
}

export interface OnboardingActionExamIds {
  "add-questions": string | null
  publish: string | null
  activate: string | null
}

export function computeOnboardingSteps(
  stats: OnboardingStats
): OnboardingStep[] {
  return [
    { id: "create-exam", done: stats.examCount > 0 },
    { id: "add-questions", done: stats.examWithQuestionsCount > 0 },
    { id: "publish", done: stats.publishedCount > 0 },
    { id: "activate", done: stats.activatedCount > 0 },
    { id: "grade", done: stats.gradedCount > 0 },
  ]
}

export function onboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.every((s) => s.done)
}

export async function fetchOnboardingStats(
  teacherId: string
): Promise<OnboardingStats> {
  const [
    examCount,
    examWithQuestionsCount,
    publishedCount,
    activatedCount,
    gradedCount,
  ] = await Promise.all([
    prisma.exam.count({ where: { creatorId: teacherId } }),
    prisma.exam.count({
      where: { creatorId: teacherId, questions: { some: {} } },
    }),
    prisma.exam.count({
      where: { creatorId: teacherId, status: { not: "DRAFT" } },
    }),
    prisma.exam.count({
      where: { creatorId: teacherId, activatedAt: { not: null } },
    }),
    prisma.exam.count({
      where: {
        creatorId: teacherId,
        OR: [{ status: "GRADED" }, { statusBeforeArchive: "GRADED" }],
      },
    }),
  ])
  return {
    examCount,
    examWithQuestionsCount,
    publishedCount,
    activatedCount,
    gradedCount,
  }
}

export async function fetchOnboardingActionExamIds(
  teacherId: string
): Promise<OnboardingActionExamIds> {
  const [addQuestionsExam, publishExam, activateExam] = await Promise.all([
    prisma.exam.findFirst({
      where: { creatorId: teacherId, status: "DRAFT" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.exam.findFirst({
      where: {
        creatorId: teacherId,
        status: "DRAFT",
        questions: { some: {} },
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.exam.findFirst({
      where: { creatorId: teacherId, status: "PUBLISHED" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
  ])

  const addQuestionsId = addQuestionsExam?.id ?? null
  const publishId = publishExam?.id ?? addQuestionsId

  return {
    "add-questions": addQuestionsId,
    publish: publishId,
    activate: activateExam?.id ?? publishId,
  }
}
