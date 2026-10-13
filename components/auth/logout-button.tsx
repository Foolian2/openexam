"use client"

import { useRouter } from "next/navigation"
import { LogOut } from "lucide-react"
import { signOut } from "@/lib/auth-client"
import { Button } from "@/components/ui/button"

export function LogoutButton() {
  const router = useRouter()

  async function handleLogout() {
    await signOut()
    router.push("/login")
  }

  return (
    <Button variant="outline" size="sm" onClick={handleLogout}>
      <LogOut className="mr-2 h-4 w-4" />
      Abmelden
    </Button>
  )
}
