import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { apiMutateToast } from "@/lib/api-mutate-toast"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("apiMutateToast", () => {
  it("toasts a literal success message and returns the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "f1" })))
    )

    const result = await apiMutateToast<{ id: string }>("/api/folders", {
      body: { name: "Ordner" },
      fallbackError: "Fehler beim Erstellen",
      success: "Ordner erstellt",
    })

    expect(toast.success).toHaveBeenCalledWith("Ordner erstellt")
    expect(toast.error).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it("calls a success function with the parsed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ created: 3 })))
    )

    await apiMutateToast<{ created: number }>("/api/question-bank/import", {
      body: { items: [] },
      fallbackError: "Import fehlgeschlagen",
      success: (data) => `${data.created} importiert`,
    })

    expect(toast.success).toHaveBeenCalledWith("3 importiert")
  })

  it("stays silent on success when no success option is given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    )

    const result = await apiMutateToast("/api/exams/e1/archive", {
      fallbackError: "Fehler beim Archivieren",
    })

    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it("toasts the server's own message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "FORBIDDEN", message: "Keine Berechtigung" },
            }),
            { status: 403 }
          )
      )
    )

    const result = await apiMutateToast("/api/exams/e1", {
      method: "DELETE",
      fallbackError: "Fehler beim Löschen",
      success: "Gelöscht",
    })

    expect(toast.error).toHaveBeenCalledWith("Keine Berechtigung")
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it("falls back to fallbackError when the failure body is unusable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>502 Bad Gateway</html>", { status: 502 })
      )
    )

    const result = await apiMutateToast("/api/exams", {
      fallbackError: "Fehler beim Erstellen",
      success: "Erstellt",
    })

    expect(toast.error).toHaveBeenCalledWith("Fehler beim Erstellen")
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })
})
