// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import {
  escapeHtmlText,
  looksLikeHtml,
  richTextLength,
  sanitizeRichText,
} from "@/lib/html-sanitize"
import { highlightKeywordsInElement } from "@/lib/keyword-highlight"

function highlight(html: string, keywords: string[]): string {
  const container = document.createElement("div")
  container.innerHTML = html
  highlightKeywordsInElement(container, keywords)
  return container.innerHTML
}

describe("sanitizeRichText", () => {
  it("strips scripts and event handlers", () => {
    const html =
      '<p>Hallo</p><script>alert(1)</script><img src=x onerror="alert(1)">'
    const out = sanitizeRichText(html)
    expect(out).not.toContain("script")
    expect(out).not.toContain("onerror")
    expect(out).toContain("Hallo")
  })

  it("keeps basic formatting tags", () => {
    const html =
      "<p><strong>fett</strong> und <em>kursiv</em></p><ul><li>Punkt</li></ul>"
    const out = sanitizeRichText(html)
    expect(out).toContain("<strong>fett</strong>")
    expect(out).toContain("<em>kursiv</em>")
    expect(out).toContain("<li>Punkt</li>")
  })

  it("drops inline styles and non-http links", () => {
    const html =
      '<p style="color:red">x</p><a href="javascript:alert(1)">böse</a><a href="https://ok.example">gut</a>'
    const out = sanitizeRichText(html)
    expect(out).not.toContain("style=")
    expect(out).not.toContain("javascript:")
    expect(out).toContain('href="https://ok.example"')
    expect(out).toContain("gut")
  })

  it("forces noopener/noreferrer on answer links", () => {
    const out = sanitizeRichText(
      '<a href="https://evil.example" target="_blank" rel="opener">x</a>'
    )
    expect(out).toContain('rel="noopener noreferrer nofollow"')
    expect(out).not.toContain('rel="opener"')
  })

  it("drops protocol-relative links", () => {
    const out = sanitizeRichText('<a href="//evil.example">x</a>')
    expect(out).not.toContain("evil.example")
    expect(out).toContain("x")
  })

  it("returns empty string for hostile input", () => {
    expect(
      sanitizeRichText("<iframe src=//evil.example></iframe>").trim()
    ).toBe("")
  })
})

describe("looksLikeHtml", () => {
  it("detects tags but not plain text with comparisons", () => {
    expect(looksLikeHtml("<p>hi</p>")).toBe(true)
    expect(looksLikeHtml("5 < 10 and 2 > 1")).toBe(false)
    expect(looksLikeHtml("a <b> c")).toBe(true)
    expect(looksLikeHtml("")).toBe(false)
  })
})

describe("escapeHtmlText", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtmlText("<b>&\"'</b>")).toBe(
      "&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;"
    )
  })
})

describe("richTextLength", () => {
  it("counts visible text only", () => {
    expect(richTextLength("<p><strong>Hallo</strong> Welt</p>")).toBe(10)
  })
})

describe("highlightKeywords", () => {
  it("wraps whole words case-insensitively", () => {
    const out = highlight("<p>Die Photosynthese findet im Blatt statt.</p>", [
      "photosynthese",
    ])
    expect(out).toContain("<mark>Photosynthese</mark>")
  })

  it("does not match a keyword inside a longer word", () => {
    const out = highlight("<p>Photosynthese und Synthese</p>", ["synthese"])
    expect(out).not.toContain("<mark>Photosynthese</mark>")
    expect(out).toContain("<mark>Synthese</mark>")
    expect(out.match(/<mark>/g)).toHaveLength(1)
  })

  it("does not match inside other words", () => {
    const out = highlight("<p>Studios und studio</p>", ["studio"])
    expect(out).toContain("<mark>studio</mark>")
    expect(out).toContain("Studios")
    expect(out.match(/<mark>/g)).toHaveLength(1)
  })

  it("matches keywords with spaces and umlauts", () => {
    const out = highlight("<p>Der Kreislauf des Wassers ist wichtig.</p>", [
      "kreislauf des wassers",
    ])
    expect(out).toContain("<mark>Kreislauf des Wassers</mark>")
  })

  it("skips nodes already inside mark and avoids nested marks", () => {
    const out = highlight("<p>hallo <mark>hallo</mark></p>", ["hallo"])
    expect(out.match(/<mark>/g)).toHaveLength(2)
    expect(out).not.toContain("<mark><mark>")
  })

  it("leaves HTML without matches untouched", () => {
    const html = "<p>nichts hier</p>"
    expect(highlight(html, ["xyz"])).toBe(html)
  })

  it("returns input unchanged without keywords", () => {
    const html = "<p>abc</p>"
    expect(highlight(html, [])).toBe(html)
    expect(highlight(html, undefined as never)).toBe(html)
  })

  it("escapes regex metacharacters in keywords", () => {
    const out = highlight("<p>Preis 100$ ist hoch</p>", ["100$"])
    expect(out).toContain("<mark>100$</mark>")
  })
})
