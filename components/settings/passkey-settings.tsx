"use client"

import { useState } from "react"
import { toast } from "sonner"
import { KeyRound, Loader2, Trash2 } from "lucide-react"
import { authClient } from "@/lib/auth-client"
import { authErrorMessage } from "@/lib/auth-error-message"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { SettingsSection } from "@/components/settings/settings-section"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"

export function PasskeySettings() {
  const {
    data: passkeys,
    isPending,
    error: listError,
    refetch,
  } = authClient.useListPasskeys()
  const [newName, setNewName] = useState("")
  const [isAdding, setIsAdding] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function handleAdd() {
    setIsAdding(true)
    const result = await authClient.passkey.addPasskey({
      name: newName.trim() || undefined,
    })
    setIsAdding(false)
    if (result?.error) {
      toast.error(
        authErrorMessage(
          result.error,
          "Passkey konnte nicht hinzugefügt werden."
        )
      )
    } else if (result?.data) {
      toast.success("Passkey hinzugefügt.")
      setNewName("")
      refetch()
    } else {
      toast.error("Passkey konnte nicht hinzugefügt werden.")
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    const result = await authClient.passkey.deletePasskey({ id })
    setDeletingId(null)
    if (result?.error) {
      toast.error(
        authErrorMessage(result.error, "Passkey konnte nicht entfernt werden.")
      )
    } else if (result?.data) {
      toast.success("Passkey entfernt.")
      refetch()
    } else {
      toast.error("Passkey konnte nicht entfernt werden.")
    }
  }

  return (
    <SettingsSection
      title="Passkeys"
      description="Melden Sie sich ohne Passwort an, z. B. mit Face ID, Windows Hello oder einem
          Sicherheitsschlüssel."
    >
      <div className="space-y-4">
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : listError ? (
          <p role="alert" className="text-sm text-destructive">
            Passkeys konnten nicht geladen werden.
          </p>
        ) : passkeys && passkeys.length > 0 ? (
          <ul className="space-y-2">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="flex items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="flex items-center gap-2 text-sm">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  <span>{passkey.name || "Passkey"}</span>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Passkey entfernen"
                      disabled={deletingId === passkey.id}
                    >
                      {deletingId === passkey.id ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Passkey entfernen?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Mit diesem Passkey ist eine Anmeldung danach nicht mehr
                        möglich.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => handleDelete(passkey.id)}
                      >
                        Entfernen
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        ) : (
          <Empty className="border bg-card">
            <EmptyMedia variant="icon">
              <KeyRound />
            </EmptyMedia>
            <EmptyTitle>Keine Passkeys</EmptyTitle>
            <EmptyDescription>
              Erstellen Sie Passkeys über das Formular unten.
            </EmptyDescription>
          </Empty>
        )}
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (z. B. Laptop, Sicherheitsschlüssel)"
            aria-label="Name des Passkeys"
            disabled={isAdding}
          />
          <Button
            type="button"
            variant="outline"
            onClick={handleAdd}
            disabled={isAdding}
            className="shrink-0"
          >
            {isAdding ? "Wird hinzugefügt…" : "Passkey hinzufügen"}
          </Button>
        </div>
      </div>
    </SettingsSection>
  )
}
