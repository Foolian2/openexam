"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Copy, Loader2, Link2, Link2Off } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface ShareDialogProps {
  item: { id: string; title: string; shareToken: string | null } | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function ShareDialog({
  item,
  onOpenChange,
  onChanged,
}: ShareDialogProps) {
  // State lives only while the dialog is open; the parent remounts it per
  // item (key=item.id) and per open, so `item` here is always the fresh row.
  const [token, setToken] = useState<string | null>(item?.shareToken ?? null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)

  const link = token
    ? `${window.location.origin}/dashboard/teacher/question-bank/shared/${token}`
    : null

  async function handleShare() {
    if (!item) return
    setLoading(true)
    try {
      const result = await apiMutateToast<{ shareToken: string }>(
        `/api/question-bank/${item.id}/share`,
        { fallbackError: "Freigabe konnte nicht erstellt werden" }
      )
      if (!result.ok) return
      setToken(result.data.shareToken)
      onChanged()
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke() {
    if (!item) return
    setRevokeOpen(false)
    const result = await apiMutateToast(`/api/question-bank/${item.id}/share`, {
      method: "DELETE",
      success: "Freigabe aufgehoben",
      fallbackError: "Freigabe konnte nicht aufgehoben werden",
    })
    if (!result.ok) return
    setToken(null)
    setCopied(false)
    onChanged()
  }

  async function handleCopy() {
    if (!link) return
    if (await copyToClipboard(link)) {
      setCopied(true)
      toast.success("Link kopiert")
      setTimeout(() => setCopied(false), 2000)
    } else {
      toast.error("Link konnte nicht kopiert werden")
    }
  }

  return (
    <>
      <Dialog open={item !== null} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Frage teilen</DialogTitle>
            <DialogDescription>
              Jede Lehrkraft mit diesem Link kann die Frage ansehen und in ihre
              eigene Fragenbank übernehmen. Die Freigabe erstellt eine Kopie —
              Änderungen an Ihrer Frage wirken nie auf fremde Kopien.
            </DialogDescription>
          </DialogHeader>

          {link ? (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input readOnly value={link} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleCopy()}
                  aria-label="Link kopieren"
                >
                  {copied ? (
                    <Link2 className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                „{item?.title ?? ""}&quot; ist derzeit über diesen Link
                abrufbar.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              „{item?.title ?? ""}&quot; ist noch nicht geteilt.
            </p>
          )}

          <DialogFooter className="flex justify-between gap-2 sm:justify-between">
            {link ? (
              <Button
                variant="outline"
                onClick={() => setRevokeOpen(true)}
                disabled={loading}
              >
                <Link2Off className="mr-2 h-4 w-4" />
                Freigabe aufheben
              </Button>
            ) : (
              <Button onClick={() => void handleShare()} disabled={loading}>
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="mr-2 h-4 w-4" />
                )}
                Freigeben
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Freigabe aufheben?</AlertDialogTitle>
            <AlertDialogDescription>
              Der Link wird ungültig. Bereits erstellte Kopien in anderen
              Fragenbanken bleiben unverändert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleRevoke()}
            >
              Aufheben
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
