import { describe, expect, it } from "vitest"
import {
  computeUploadBudgetBytes,
  effectiveMaxFileSizeMB,
  MAX_UPLOAD_MB,
  UPLOAD_MIN_BUDGET_BYTES,
} from "@/lib/upload-budget"
import type { FileUploadConfig } from "@/lib/types/questions"

function question(maxFileSizeMB: number): FileUploadConfig {
  return { maxFileSizeMB, allowedExtensions: [".pdf"], instructions: "" }
}

describe("computeUploadBudgetBytes", () => {
  it("floors small exams at the minimum budget", () => {
    expect(computeUploadBudgetBytes([question(10)])).toBe(UPLOAD_MIN_BUDGET_BYTES)
    expect(computeUploadBudgetBytes([])).toBe(UPLOAD_MIN_BUDGET_BYTES)
  })

  it("allows twice the exam's upload capacity above the floor", () => {
    const many = Array.from({ length: 12 }, () => question(25))
    expect(computeUploadBudgetBytes(many)).toBe(2 * 12 * 25 * 1024 * 1024)
  })

  it("counts each question at the enforced cap, not its stored config", () => {
    // A pre-cap 100 MB config is only ever allowed MAX_UPLOAD_MB per file.
    const legacy = Array.from({ length: 12 }, () => question(100))
    expect(computeUploadBudgetBytes(legacy)).toBe(
      2 * 12 * MAX_UPLOAD_MB * 1024 * 1024
    )
  })

  it("ignores questions without a numeric size cap", () => {
    const broken = { allowedExtensions: [".pdf"] } as unknown as FileUploadConfig
    expect(computeUploadBudgetBytes([broken])).toBe(UPLOAD_MIN_BUDGET_BYTES)
  })
})

describe("effectiveMaxFileSizeMB", () => {
  it("keeps configs at or below the cap", () => {
    expect(effectiveMaxFileSizeMB(question(10))).toBe(10)
    expect(effectiveMaxFileSizeMB(question(MAX_UPLOAD_MB))).toBe(MAX_UPLOAD_MB)
  })

  it("clamps configs above the cap", () => {
    expect(effectiveMaxFileSizeMB(question(100))).toBe(MAX_UPLOAD_MB)
  })
})
