"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

interface FolderActionsProps {
  folder: { id: string; name: string }
  isActive: boolean
  onDeleted: () => void
  onRenamed: (name: string) => void
}

export function FolderActions({
  folder,
  isActive,
  onDeleted,
  onRenamed,
}: FolderActionsProps) {
  const router = useRouter()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [name, setName] = useState(folder.name)
  const [isSaving, setIsSaving] = useState(false)

  async function handleRename() {
    if (!name.trim()) return
    setIsSaving(true)
    try {
      const result = await apiMutateToast(`/api/folders/${folder.id}`, {
        method: "PATCH",
        body: { name: name.trim() },
        success: "Ordner umbenannt",
        fallbackError: "Fehler beim Umbenennen",
      })
      if (!result.ok) return
      setRenameOpen(false)
      onRenamed(name.trim())
      router.refresh()
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    const result = await apiMutateToast(`/api/folders/${folder.id}`, {
      method: "DELETE",
      success: "Ordner gelöscht",
      fallbackError: "Fehler beim Löschen",
    })
    if (!result.ok) return
    onDeleted()
    if (isActive) router.push("/dashboard/teacher")
    else router.refresh()
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground opacity-0 group-hover/folder:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
            onClick={(e) => e.preventDefault()}
            aria-label={`Aktionen für Ordner ${folder.name}`}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="right">
          <DropdownMenuItem
            onClick={() => {
              setName(folder.name)
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
        onOpenChange={(next) => !isSaving && setRenameOpen(next)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ordner umbenennen</DialogTitle>
          </DialogHeader>
          <div>
            <Label htmlFor={`rename-folder-${folder.id}`}>Name *</Label>
            <Input
              id={`rename-folder-${folder.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="mt-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isSaving && name.trim()) {
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
              disabled={isSaving}
            >
              Abbrechen
            </Button>
            <Button onClick={handleRename} disabled={isSaving || !name.trim()}>
              {isSaving ? "Wird gespeichert…" : "Speichern"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ordner löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{folder.name}&quot; wird gelöscht. Enthaltene Prüfungen und
              Fragenbank-Einträge werden nicht gelöscht, sondern nur aus dem
              Ordner entfernt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                setDeleteOpen(false)
                void handleDelete()
              }}
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
