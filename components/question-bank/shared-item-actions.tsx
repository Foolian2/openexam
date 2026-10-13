"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { BookMarked, Loader2 } from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { Button } from "@/components/ui/button"

interface SharedItemActionsProps {
  token: string
  isOwn: boolean
}

export function SharedItemActions({ token, isOwn }: SharedItemActionsProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleCopy() {
    setLoading(true)
    try {
      const result = await apiMutateToast<{ deduplicated?: boolean }>(
        `/api/question-bank/shared/${token}`,
        {
          success: (d) =>
            d.deduplicated
              ? "Diese Frage ist bereits in Ihrer Fragenbank"
              : "Frage in Ihre Fragenbank übernommen",
          fallbackError: "Übernahme fehlgeschlagen",
        }
      )
      if (!result.ok) return
      router.push("/dashboard/teacher/question-bank")
    } finally {
      setLoading(false)
    }
  }

  if (isOwn) {
    return (
      <p className="text-sm text-muted-foreground">
        Diese Frage stammt aus Ihrer eigenen Fragenbank.
      </p>
    )
  }

  return (
    <Button onClick={() => void handleCopy()} disabled={loading}>
      {loading ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <BookMarked className="mr-2 h-4 w-4" />
      )}
      In meine Fragenbank übernehmen
    </Button>
  )
}
