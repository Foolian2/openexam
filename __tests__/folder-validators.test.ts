import { describe, expect, it } from "vitest"
import { createFolderSchema } from "@/lib/validators/folder"

describe("createFolderSchema", () => {
  it("rejects a name of only spaces", () => {
    expect(createFolderSchema.safeParse({ name: "   " }).success).toBe(false)
  })

  it("stores the trimmed name", () => {
    expect(createFolderSchema.parse({ name: "  Mathe " }).name).toBe("Mathe")
  })
})
