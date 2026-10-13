import { describe, expect, it } from "vitest"
import { configSchemaByType, createQuestionSchema } from "@/lib/validators/question"
import { MAX_UPLOAD_MB } from "@/lib/upload-budget"

const config = (maxFileSizeMB: number) => ({
  allowedExtensions: [".pdf"],
  maxFileSizeMB,
  instructions: "",
})

describe("FILE_UPLOAD size cap", () => {
  it("clamps a pre-cap 100 MB config instead of rejecting it", () => {
    const r = configSchemaByType.FILE_UPLOAD.safeParse(config(100))
    expect(r.success).toBe(true)
    expect(r.success && r.data.maxFileSizeMB).toBe(MAX_UPLOAD_MB)
  })

  it("keeps a config under the cap unchanged", () => {
    const r = configSchemaByType.FILE_UPLOAD.safeParse(config(10))
    expect(r.success && r.data.maxFileSizeMB).toBe(10)
  })

  it("still rejects sizes below 1 MB", () => {
    expect(configSchemaByType.FILE_UPLOAD.safeParse(config(0)).success).toBe(false)
  })

  it("clamps through the create-question schema too", () => {
    const r = createQuestionSchema.safeParse({
      title: "Upload",
      points: 1,
      type: "FILE_UPLOAD",
      config: config(80),
    })
    expect(r.success).toBe(true)
    expect(r.success && (r.data.config as { maxFileSizeMB: number }).maxFileSizeMB).toBe(
      MAX_UPLOAD_MB
    )
  })
})
