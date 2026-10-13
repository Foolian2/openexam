"use client"

import { useEffect, useState } from "react"
import { Loader2, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty"
import { useDebouncedCallback } from "@/hooks/use-debounced-callback"
import { SEB_FILE_UPLOAD_MESSAGE } from "@/lib/seb-question-policy"
import type { QuestionType } from "@/generated/prisma/client"
import { QUESTION_TYPE_LABELS } from "@/lib/constants/question-types"

interface BankItem {
  id: string
  type: QuestionType
  title: string
  points: number
}

interface BankPickerDialogProps {
  open: boolean
  sebRequired?: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (item: BankItem) => void
}

async function fetchBankItems(q: string): Promise<BankItem[] | null> {
  const params = new URLSearchParams()
  if (q) params.set("q", q)
  const res = await fetch(`/api/question-bank?${params.toString()}`)
  if (!res.ok) return null
  const data = await res.json()
  return data.items
}

export function BankPickerDialog({
  open,
  sebRequired = false,
  onOpenChange,
  onSelect,
}: BankPickerDialogProps) {
  const [items, setItems] = useState<BankItem[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")

  // Fetches the current list whenever the dialog opens — reusing whatever
  // search term was left from the previous time it was open, which is a
  // harmless (arguably convenient) UX tradeoff for not resetting state.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const result = await fetchBankItems(query)
        if (!cancelled && result) setItems(result)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const debouncedLoad = useDebouncedCallback(async (q: string) => {
    setLoading(true)
    try {
      const result = await fetchBankItems(q)
      if (result) setItems(result)
    } finally {
      setLoading(false)
    }
  }, 300)

  function handleQueryChange(value: string) {
    setQuery(value)
    debouncedLoad(value)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Aus Fragenbank einfügen</DialogTitle>
          <DialogDescription>
            Wählen Sie eine wiederverwendbare Frage aus Ihrer Fragenbank. Sie
            wird als unabhängige Kopie in diese Prüfung eingefügt.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Fragenbank durchsuchen…"
            className="pl-8"
            autoFocus
          />
        </div>

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!loading && items.length === 0 && (
            <Empty className="border bg-card">
              <EmptyTitle>Keine Fragen gefunden</EmptyTitle>
              <EmptyDescription>
                {query
                  ? "Keine Fragen entsprechen der Suche."
                  : "Fügen Sie zuerst Fragen zu Ihrer Fragenbank hinzu."}
              </EmptyDescription>
            </Empty>
          )}
          {!loading &&
            items.map((item) => (
              <button
                key={item.id}
                disabled={sebRequired && item.type === "FILE_UPLOAD"}
                onClick={() => onSelect(item)}
                className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {item.title || "(Ohne Titel)"}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <Badge variant="outline" className="h-5 text-xs">
                      {QUESTION_TYPE_LABELS[item.type]}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {item.points} Punkte
                    </span>
                  </div>
                  {sebRequired && item.type === "FILE_UPLOAD" && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {SEB_FILE_UPLOAD_MESSAGE}
                    </p>
                  )}
                </div>
              </button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
