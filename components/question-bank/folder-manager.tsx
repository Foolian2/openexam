"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { FolderPlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface BankFolder {
  id: string
  name: string
}

/** Creates a folder from the Fragenbank page — same /api/folders contract as the sidebar dialog. */
export function NewBankFolderButton({ onCreated }: { onCreated: () => void }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)

  async function handleCreate() {
    if (!name.trim()) return
    setCreating(true)
    try {
      const result = await apiMutateToast("/api/folders", {
        body: { name: name.trim() },
        success: "Ordner erstellt",
        fallbackError: "Fehler beim Erstellen",
      })
      if (!result.ok) return
      setOpen(false)
      setName("")
      onCreated()
      router.refresh()
    } finally {
      setCreating(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Neuer Ordner"
      >
        <FolderPlus className="h-4 w-4" />
        Neuer Ordner
      </Button>
      <Dialog open={open} onOpenChange={(next) => !creating && setOpen(next)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Neuer Ordner</DialogTitle>
          </DialogHeader>
          <div>
            <Label htmlFor="bank-new-folder-name">Name *</Label>
            <Input
              id="bank-new-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="z.B. Semester 1"
              maxLength={100}
              className="mt-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !creating && name.trim()) {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={creating}
            >
              Abbrechen
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={creating || !name.trim()}
            >
              {creating ? "Wird erstellt…" : "Ordner erstellen"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Rename/delete the folder currently selected in the bank filter. */
export function SelectedFolderActions({
  folder,
  onDeleted,
}: {
  folder: BankFolder | null
  onDeleted: () => void
}) {
  const router = useRouter()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [name, setName] = useState(folder?.name ?? "")
  const [saving, setSaving] = useState(false)

  async function handleRename() {
    if (!folder || !name.trim()) return
    setSaving(true)
    try {
      const result = await apiMutateToast(`/api/folders/${folder.id}`, {
        method: "PATCH",
        body: { name: name.trim() },
        success: "Ordner umbenannt",
        fallbackError: "Fehler beim Umbenennen",
      })
      if (!result.ok) return
      setRenameOpen(false)
      router.refresh()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!folder) return
    const result = await apiMutateToast(`/api/folders/${folder.id}`, {
      method: "DELETE",
      success: "Ordner gelöscht",
      fallbackError: "Fehler beim Löschen",
    })
    if (!result.ok) return
    setDeleteOpen(false)
    onDeleted()
    router.refresh()
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={!folder}
            aria-label="Ordner-Aktionen"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onClick={() => {
              setName(folder?.name ?? "")
              setRenameOpen(true)
            }}
          >
            <Pencil className="mr-2 size-4" />
            Umbenennen
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-2 size-4" />
            Löschen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={renameOpen}
        onOpenChange={(next) => !saving && setRenameOpen(next)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ordner umbenennen</DialogTitle>
          </DialogHeader>
          <div>
            <Label htmlFor="bank-rename-folder-name">Name *</Label>
            <Input
              id="bank-rename-folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="mt-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !saving && name.trim()) {
                  e.preventDefault()
                  void handleRename()
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameOpen(false)}
              disabled={saving}
            >
              Abbrechen
            </Button>
            <Button
              onClick={() => void handleRename()}
              disabled={saving || !name.trim()}
            >
              {saving ? "Wird gespeichert…" : "Speichern"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ordner löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{folder?.name}&quot; wird gelöscht. Enthaltene Prüfungen und
              Fragenbank-Einträge werden nicht gelöscht, sondern nur aus dem
              Ordner entfernt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => void handleDelete()}
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
