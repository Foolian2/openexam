import { describe, expect, it, vi } from "vitest"

// lib/onboarding imports @/lib/prisma, which reads DATABASE_URL at import
// time — stub it out so pure-logic tests run without a database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import {
  computeOnboardingSteps,
  onboardingComplete,
  type OnboardingStats,
} from "@/lib/onboarding"

function stats(overrides: Partial<OnboardingStats> = {}): OnboardingStats {
  return {
    examCount: 0,
    examWithQuestionsCount: 0,
    publishedCount: 0,
    activatedCount: 0,
    gradedCount: 0,
    ...overrides,
  }
}

describe("computeOnboardingSteps", () => {
  it("marks every step incomplete for a brand-new teacher", () => {
    const steps = computeOnboardingSteps(stats())
    expect(steps).toHaveLength(5)
    expect(steps.every((s) => !s.done)).toBe(true)
  })

  it("marks create-exam done once an exam exists", () => {
    const steps = computeOnboardingSteps(stats({ examCount: 1 }))
    expect(steps.find((s) => s.id === "create-exam")?.done).toBe(true)
    expect(steps.find((s) => s.id === "add-questions")?.done).toBe(false)
  })

  it("marks add-questions done once an exam has questions", () => {
    const steps = computeOnboardingSteps(
      stats({ examCount: 1, examWithQuestionsCount: 1 })
    )
    expect(steps.find((s) => s.id === "add-questions")?.done).toBe(true)
  })

  it("marks publish done once an exam leaves DRAFT", () => {
    const steps = computeOnboardingSteps(stats({ publishedCount: 1 }))
    expect(steps.find((s) => s.id === "publish")?.done).toBe(true)
  })

  it("marks activate done once an exam was activated", () => {
    const steps = computeOnboardingSteps(stats({ activatedCount: 1 }))
    expect(steps.find((s) => s.id === "activate")?.done).toBe(true)
  })

  it("marks grade done once an exam is graded", () => {
    const steps = computeOnboardingSteps(stats({ gradedCount: 1 }))
    expect(steps.find((s) => s.id === "grade")?.done).toBe(true)
  })

  it("returns steps in a stable order", () => {
    const steps = computeOnboardingSteps(stats())
    expect(steps.map((s) => s.id)).toEqual([
      "create-exam",
      "add-questions",
      "publish",
      "activate",
      "grade",
    ])
  })
})

describe("onboardingComplete", () => {
  it("is false when any step is incomplete", () => {
    const steps = computeOnboardingSteps(
      stats({ examCount: 1, examWithQuestionsCount: 1, publishedCount: 1 })
    )
    expect(onboardingComplete(steps)).toBe(false)
  })

  it("is true when all steps are done", () => {
    const steps = computeOnboardingSteps(
      stats({
        examCount: 1,
        examWithQuestionsCount: 1,
        publishedCount: 1,
        activatedCount: 1,
        gradedCount: 1,
      })
    )
    expect(onboardingComplete(steps)).toBe(true)
  })
})
