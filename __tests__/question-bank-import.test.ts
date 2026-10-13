import { describe, expect, it } from "vitest"
import { splitQuestionBankImport } from "@/lib/question-bank-import"

function payloadSize(items: unknown[]): number {
  return new TextEncoder().encode(JSON.stringify({ items })).byteLength
}

describe("splitQuestionBankImport", () => {
  it("splits batches by UTF-8 payload size without dropping or reordering items", () => {
    const items = [
      { title: "Frage 1", config: "😀".repeat(10) },
      { title: "Frage 2", config: "ä".repeat(10) },
      { title: "Frage 3", config: "x".repeat(10) },
    ]
    const maxBytes = payloadSize(items.slice(0, 2)) - 1

    const batches = splitQuestionBankImport(items, maxBytes)

    expect(batches.flat()).toEqual(items)
    expect(batches).toHaveLength(2)
    expect(batches.every((batch) => payloadSize(batch) <= maxBytes)).toBe(true)
  })

  it("returns no batches for an empty import", () => {
    expect(splitQuestionBankImport([])).toEqual([])
  })
})
