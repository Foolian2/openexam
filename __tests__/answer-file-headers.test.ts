import { describe, expect, it } from "vitest"
import { downloadHeaders } from "@/lib/answer-file-headers"

describe("downloadHeaders", () => {
  it("never lets the browser render the file", () => {
    const h = downloadHeaders("loesung.html", 42)
    expect(h.get("Content-Type")).toBe("application/octet-stream")
    expect(h.get("Content-Disposition")).toMatch(/^attachment;/)
    expect(h.get("X-Content-Type-Options")).toBe("nosniff")
    expect(h.get("Content-Security-Policy")).toBe("sandbox")
    expect(h.get("Cache-Control")).toBe("private, no-store")
    expect(h.get("Content-Length")).toBe("42")
  })

  it("keeps a student-chosen name from breaking out of the quoted filename", () => {
    const h = downloadHeaders('a"; filename="evil.html', 1)
    const cd = h.get("Content-Disposition")!
    const quoted = cd.match(/filename="([^"]*)"/)![1]
    expect(quoted).toBe("a_; filename=_evil.html")
    expect(cd.match(/filename="/g)).toHaveLength(1)
  })

  it("carries the exact UTF-8 name in RFC 5987 form", () => {
    const h = downloadHeaders("Prüfung (Teil 1)'s.pdf", 1)
    const cd = h.get("Content-Disposition")!
    expect(cd).toContain(`filename="Pr_fung (Teil 1)'s.pdf"`)
    expect(cd).toContain(
      "filename*=UTF-8''Pr%C3%BCfung%20%28Teil%201%29%27s.pdf"
    )
    expect(decodeURIComponent(cd.split("''")[1])).toBe("Prüfung (Teil 1)'s.pdf")
  })

  it("falls back to a generic name when none was stored", () => {
    expect(downloadHeaders(undefined, 1).get("Content-Disposition")).toContain(
      'filename="datei"'
    )
  })
})
