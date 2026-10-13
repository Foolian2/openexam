import { afterEach, describe, expect, it, vi } from "vitest"
import { apiMutate, type Fetcher } from "@/lib/api-mutate"

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Build a reply in the envelope shape lib/api-response.ts guarantees. */
function errorReply(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status })
}

describe("apiMutate", () => {
  it("returns the parsed body and status on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ exam: { id: "e1" } })))
    )

    const result = await apiMutate<{ exam: { id: string } }>("/api/exams", {
      body: { title: "Probe" },
      fallbackError: "Fehler beim Erstellen",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.exam.id).toBe("e1")
    expect(result.status).toBe(200)
  })

  it("surfaces the server's own message and code rather than the fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorReply("FORBIDDEN", "Keine Berechtigung", 403))
    )

    const result = await apiMutate("/api/exams/e1", {
      method: "DELETE",
      fallbackError: "Fehler beim Löschen",
    })

    expect(result).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
      message: "Keine Berechtigung",
      status: 403,
    })
  })

  it("preserves the status so a caller can treat 409 as already-done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => errorReply("CONFLICT", "Bereits abgegeben", 409))
    )

    const result = await apiMutate("/api/sessions/s1/submit", {
      fallbackError: "Abgabe fehlgeschlagen",
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    if (result.ok) return
    expect(result.code).toBe("CONFLICT")
  })

  it("falls back when the failure body is not the error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>502 Bad Gateway</html>", { status: 502 })
      )
    )

    const result = await apiMutate("/api/exams", {
      fallbackError: "Fehler beim Erstellen",
    })

    expect(result).toMatchObject({
      ok: false,
      code: null,
      message: "Fehler beim Erstellen",
      status: 502,
    })
  })

  it("keeps the parsed body on failure so a partial success is not lost", async () => {
    // The question-bank import relies on this: a rejected batch still lists
    // the per-item failures that landed.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ created: 2, failed: [{ index: 3 }] }), {
            status: 422,
          })
      )
    )

    const result = await apiMutate("/api/question-bank/import", {
      body: { items: [] },
      fallbackError: "Import fehlgeschlagen",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.payload).toMatchObject({ created: 2, failed: [{ index: 3 }] })
  })

  it("treats an empty success body as success rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    )

    const result = await apiMutate("/api/folders/f1", {
      method: "DELETE",
      fallbackError: "Fehler beim Löschen",
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(204)
  })

  it("rejects a 2xx whose body is not the API's JSON", async () => {
    // A proxy or captive portal answering 200 with an HTML page is not this
    // API replying. Reporting it as success would let the exam submit path
    // clear the student's locally buffered answers and navigate away for a
    // submission that was never confirmed.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>Anmeldung erforderlich</html>", { status: 200 })
      )
    )

    const result = await apiMutate("/api/sessions/s1/submit", {
      fallbackError: "Abgabe fehlgeschlagen",
      networkError: "Netzwerkfehler bei der Abgabe.",
    })

    expect(result).toMatchObject({
      ok: false,
      code: null,
      message: "Netzwerkfehler bei der Abgabe.",
      status: 200,
    })
  })

  it.each(["", "   \n"])(
    "does not mistake an empty 200 body for a payload",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 200 }))
      )

      const result = await apiMutate("/api/exams/e1/archive", {
        fallbackError: "Fehler beim Archivieren",
      })

      expect(result).toMatchObject({
        ok: false,
        code: null,
        message: "Fehler beim Archivieren",
        status: 200,
      })
    }
  )

  it("does not expose a malformed 409 as an API conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Conflict</html>", { status: 409 }))
    )

    const result = await apiMutate("/api/sessions/s1/submit", {
      fallbackError: "Abgabe fehlgeschlagen",
    })

    expect(result).toMatchObject({
      ok: false,
      code: null,
      message: "Abgabe fehlgeschlagen",
      status: 409,
    })
  })

  it("allows an empty 205 reset-content response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 205 }))
    )

    const result = await apiMutate("/api/preferences", {
      fallbackError: "Fehler beim Zurücksetzen",
    })

    expect(result.ok).toBe(true)
    expect(result.status).toBe(205)
  })

  it("resolves rather than rejecting when the request never reaches the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      })
    )

    const result = await apiMutate("/api/exams", {
      fallbackError: "Fehler beim Speichern",
      networkError: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
    })

    expect(result).toMatchObject({
      ok: false,
      code: null,
      message: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
      status: 0,
    })
  })

  it("uses fallbackError for a transport failure when no networkError is given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      })
    )

    const result = await apiMutate("/api/exams", {
      fallbackError: "Fehler beim Speichern",
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe("Fehler beim Speichern")
  })

  it("JSON-encodes an object body and sets the content type", async () => {
    const send = vi.fn<Fetcher>(async () => new Response("{}"))
    vi.stubGlobal("fetch", send)

    await apiMutate("/api/folders", {
      body: { name: "Ordner" },
      fallbackError: "Fehler beim Erstellen",
    })

    const init = send.mock.calls[0][1] as RequestInit
    expect(init.body).toBe(JSON.stringify({ name: "Ordner" }))
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" })
  })

  it("sends FormData untouched so the browser can set the multipart boundary", async () => {
    const send = vi.fn<Fetcher>(async () => new Response("{}"))
    vi.stubGlobal("fetch", send)

    const body = new FormData()
    body.append("file", "x")

    await apiMutate("/api/sessions/s1/upload", {
      body,
      fallbackError: "Upload fehlgeschlagen",
    })

    const init = send.mock.calls[0][1] as RequestInit
    expect(init.body).toBe(body)
    expect(init.headers).not.toHaveProperty("Content-Type")
  })

  it("sends no body at all when none is given", async () => {
    const send = vi.fn<Fetcher>(async () => new Response("{}"))
    vi.stubGlobal("fetch", send)

    await apiMutate("/api/exams/e1/publish", { fallbackError: "Fehler" })

    const init = send.mock.calls[0][1] as RequestInit
    expect(init.body).toBeUndefined()
    expect(init.method).toBe("POST")
  })

  it("routes through an injected fetcher instead of the global fetch", async () => {
    const globalFetch = vi.fn(async () => new Response("{}"))
    vi.stubGlobal("fetch", globalFetch)
    const sebFetch: Fetcher = vi.fn(async () => new Response("{}"))

    await apiMutate("/api/sessions/s1/answers", {
      method: "PUT",
      body: { questionId: "q1" },
      fetcher: sebFetch,
      fallbackError: "Speichern fehlgeschlagen",
    })

    expect(sebFetch).toHaveBeenCalledOnce()
    expect(globalFetch).not.toHaveBeenCalled()
  })
})
