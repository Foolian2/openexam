import { describe, expect, it } from "vitest"
import {
  nextBlankId,
  parseBlankIds,
  placeholderIds,
} from "@/lib/fill-blank-template"

describe("fill-blank template helpers", () => {
  it("lists placeholders in order, duplicates included", () => {
    expect(placeholderIds("a {2} b {1} c {2}")).toEqual(["2", "1", "2"])
  })

  it("lists distinct ids sorted numerically", () => {
    expect(parseBlankIds("{10} {2} {2} {1}")).toEqual(["1", "2", "10"])
  })

  it("starts at 1 for a template without blanks", () => {
    expect(nextBlankId("Kein Platzhalter")).toBe("1")
  })

  it("does not reuse an id after a middle blank was removed", () => {
    // {1} {2} {3}, then {2} deleted: counting blanks would give {3} again.
    expect(nextBlankId("Eins {1}, zwei, drei {3}.")).toBe("4")
  })

  it("continues after the highest id", () => {
    expect(nextBlankId("{1} {2}")).toBe("3")
  })
})
