import { describe, expect, it } from "vitest"
import { csvField } from "@/lib/csv"

describe("csvField", () => {
  it("passes plain values through unquoted", () => {
    expect(csvField("Anna Muster")).toBe("Anna Muster")
    expect(csvField(12)).toBe("12")
    expect(csvField(null)).toBe("")
    expect(csvField(undefined)).toBe("")
  })

  it("quotes and doubles embedded quotes", () => {
    expect(csvField('sagt "hallo"')).toBe('"sagt ""hallo"""')
  })

  it("quotes the configured delimiter only", () => {
    expect(csvField("a;b", ",")).toBe("a;b")
    expect(csvField("a;b", ";")).toBe('"a;b"')
    expect(csvField("a,b", ",")).toBe('"a,b"')
  })

  it("quotes newlines", () => {
    expect(csvField("a\nb")).toBe('"a\nb"')
  })

  it("neutralizes spreadsheet formulas", () => {
    // A student-controlled User-Agent reaches the audit CSV verbatim.
    expect(csvField('=HYPERLINK("https://evil.example","x")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"",""x"")"'
    )
    expect(csvField("+1234")).toBe("'+1234")
    expect(csvField("-1+2")).toBe("'-1+2")
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)")
  })

  it("sees past leading whitespace and control characters", () => {
    // Spreadsheet apps skip these before deciding a cell is a formula.
    expect(csvField("   =1+1")).toBe("'   =1+1")
    expect(csvField("\t=1+1")).toBe("'\t=1+1")
  })

  it("neutralizes formulas behind a lone carriage return and unicode spaces", () => {
    // CWE-1236: a lone CR is a trigger in its own right, and NBSP is
    // skipped by spreadsheet parsers just like ASCII whitespace.
    expect(csvField("\r=1+1")).toBe('"\'\r=1+1"')
    expect(csvField("\r\t+SUM(A1)")).toBe('"\'\r\t+SUM(A1)"')
    expect(csvField("\u00a0=1+1")).toBe("'\u00a0=1+1")
    expect(csvField("\u00a0@HYPERLINK(1)")).toBe("'\u00a0@HYPERLINK(1)")
  })

  it("leaves values that merely contain a formula character alone", () => {
    expect(csvField("a=b")).toBe("a=b")
  })

  it("neutralizes a bare leading tab even with no following operator", () => {
    // Per the module doc comment, a leading tab is itself a formula-injection
    // trigger in Excel/LibreOffice, independent of any =/+/-/@ that follows.
    expect(csvField("\tfoo")).toBe("'\tfoo")
  })

  it("neutralizes formulas hidden behind zero-width and bidi format characters", () => {
    // CVSS 4.6 finding: Excel/Google Sheets discard Cf-category invisible
    // characters before formula detection, so a display name like
    // "​=2+2" (zero-width space) reached the export verbatim and was
    // evaluated as a formula despite the visible lead-in check.
    expect(csvField("​=2+2")).toBe("'​=2+2")
    expect(csvField("​=HYPERLINK(1)")).toBe("'​=HYPERLINK(1)")
    expect(csvField("﻿+1234")).toBe("'﻿+1234")
    // U+202A LEFT-TO-RIGHT EMBEDDING is the payload under test, not stray
    // markup: the assertion exists to prove csvField neutralises a formula
    // hidden behind a bidi control. Removing the character removes the test.
    // nosemgrep: generic.unicode.security.bidi.contains-bidirectional-characters
    expect(csvField("‪@SUM(A1)")).toBe("'‪@SUM(A1)")
    expect(csvField("⁠-1")).toBe("'⁠-1")
  })
})
