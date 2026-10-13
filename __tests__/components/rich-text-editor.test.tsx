// @vitest-environment happy-dom
import { render, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"

import { RichTextEditor } from "@/components/rich-text/rich-text-editor"

// The editor runs inside SEB, where any link to /exam/<id>/quit is an exit
// without the quit password. Neither stored anchors nor typed URLs may come
// back out as <a> elements.
it("renders no links, from stored anchors or bare URLs", async () => {
  const onChange = vi.fn()
  const { container } = render(
    <RichTextEditor
      value='<p><a href="/exam/e1/quit">beenden</a> https://example.com/exam/e1/quit</p>'
      onChange={onChange}
      maxLength={1000}
    />
  )

  const prose = await waitFor(() => {
    const el = container.querySelector(".ProseMirror")
    expect(el).not.toBeNull()
    return el!
  })
  expect(prose.textContent).toContain("beenden")
  expect(prose.textContent).toContain("https://example.com/exam/e1/quit")
  expect(container.querySelector("a")).toBeNull()
})
