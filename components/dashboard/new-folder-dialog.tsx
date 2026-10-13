"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { FolderPlus } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function NewFolderDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  async function handleCreate() {
    if (!name.trim()) return
    setIsCreating(true)
    try {
      const result = await apiMutateToast("/api/folders", {
        body: { name: name.trim() },
        fallbackError: "Fehler beim Erstellen",
      })
      if (!result.ok) return
      setOpen(false)
      setName("")
      router.refresh()
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !isCreating && setOpen(next)}>
      <DialogTrigger asChild>
        <button className="flex h-7 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
          <FolderPlus className="size-4 shrink-0" />
          <span className="truncate">Neuer Ordner</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Neuer Ordner</DialogTitle>
          <DialogDescription>
            Ordner helfen, Prüfungen zu gruppieren, z.B. nach Semester oder
            Klasse.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="new-folder-name">Name *</Label>
          <Input
            id="new-folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="z.B. Semester 1"
            maxLength={100}
            className="mt-1"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isCreating && name.trim()) {
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
            disabled={isCreating}
          >
            Abbrechen
          </Button>
          <Button onClick={handleCreate} disabled={isCreating || !name.trim()}>
            {isCreating ? "Wird erstellt…" : "Ordner erstellen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
