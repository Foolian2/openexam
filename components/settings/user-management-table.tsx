"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Search, Users } from "lucide-react"
import { useQueryStates, debounce } from "nuqs"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { Role } from "@/generated/prisma/client"
import { userManagementSearchParams } from "@/lib/search-params/user-management"
import { tablePendingClass } from "@/lib/search-params/shared"
import { DataTablePagination } from "@/components/shared/data-table-pagination"
import { cn } from "@/lib/utils"
import { formatDate } from "@/lib/format-date"

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "STUDENT", label: "Lernende" },
  { value: "TEACHER", label: "Lehrperson" },
  { value: "ADMIN", label: "Admin" },
]

export interface ManagedUser {
  id: string
  name: string
  email: string
  role: Role
  emailVerified: boolean
  createdAt: string
}

interface UserManagementTableProps {
  users: ManagedUser[]
  total: number
  limit: number
  currentUserId: string
}

export function UserManagementTable({
  users,
  total,
  limit,
  currentUserId,
}: UserManagementTableProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [filters, setFilters] = useQueryStates(userManagementSearchParams, {
    startTransition,
  })
  const totalPages = Math.ceil(total / limit)
  const [pendingUserId, setPendingUserId] = useState<string | null>(null)

  async function handleRoleChange(user: ManagedUser, role: Role) {
    setPendingUserId(user.id)
    try {
      const result = await apiMutateToast(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: { role },
        success: `Rolle von ${user.name} geändert`,
        fallbackError: "Fehler beim Ändern der Rolle",
        networkError: "Verbindungsfehler. Bitte versuchen Sie es erneut.",
      })
      if (result.ok) router.refresh()
    } finally {
      setPendingUserId(null)
    }
  }

  return (
    <div className={cn("space-y-4", tablePendingClass(isPending))}>
      <div className="relative w-full max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.q}
          onChange={(e) =>
            setFilters(
              { q: e.target.value, page: 1 },
              { limitUrlUpdates: debounce(400) }
            )
          }
          placeholder="Benutzer suchen…"
          className="pl-8"
          aria-label="Benutzer durchsuchen"
        />
      </div>

      {users.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>Keine Benutzer gefunden</EmptyTitle>
            <EmptyDescription>
              Keine Benutzer entsprechen der aktuellen Suche.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>E-Mail</TableHead>
                  <TableHead>Registriert</TableHead>
                  <TableHead className="w-40">Rolle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {user.email}
                    </TableCell>
                    <TableCell
                      className="text-sm text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={user.role}
                        disabled={
                          user.id === currentUserId || pendingUserId === user.id
                        }
                        onValueChange={(value) =>
                          handleRoleChange(user, value as Role)
                        }
                      >
                        <SelectTrigger
                          aria-label={`Rolle von ${user.name}`}
                          title={
                            user.id === currentUserId
                              ? "Die eigene Rolle kann nicht geändert werden"
                              : undefined
                          }
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DataTablePagination
            page={filters.page}
            totalPages={totalPages}
            total={total}
            limit={limit}
            label="Benutzern"
            onPageChange={(p) => setFilters({ page: p })}
          />
        </>
      )}
    </div>
  )
}
