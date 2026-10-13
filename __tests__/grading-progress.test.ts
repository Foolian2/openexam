import { describe, expect, it } from "vitest"

import { getGradingProgress } from "@/lib/grading-progress"

const questions = (...points: number[]) =>
  points.map((p, i) => ({ id: `q${i + 1}`, points: p }))

describe("getGradingProgress", () => {
  it("counts entered grades and identifies the first open question", () => {
    expect(
      getGradingProgress(questions(2, 2, 2), {
        q1: { points: "2" },
        q2: { points: "" },
        q3: { points: "0" },
      })
    ).toEqual({ graded: 2, total: 3, open: 1, firstOpenId: "q2" })
  })

  it("treats whitespace and missing drafts as open", () => {
    expect(
      getGradingProgress(questions(2, 2), {
        q1: { points: "   " },
      })
    ).toEqual({ graded: 0, total: 2, open: 2, firstOpenId: "q1" })
  })

  it("reports completion when every question has a score", () => {
    expect(
      getGradingProgress(questions(2, 2), {
        q1: { points: "0" },
        q2: { points: "1.5" },
      })
    ).toEqual({ graded: 2, total: 2, open: 0, firstOpenId: null })
  })

  it("treats out-of-range scores as open, matching save validation", () => {
    expect(
      getGradingProgress(questions(2, 5), {
        q1: { points: "-1" },
        q2: { points: "999" },
      })
    ).toEqual({ graded: 0, total: 2, open: 2, firstOpenId: "q1" })
  })
})
