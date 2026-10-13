"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { CalendarIcon, Download, Loader2, ScrollText } from "lucide-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { useQueryStates, debounce } from "nuqs"
import {
  AUDIT_ACTION_LABELS,
  EXAM_SCOPED_AUDIT_ACTIONS,
  auditActionLabel,
} from "@/lib/audit-actions"
import {
  auditSearchParams,
  serializeAuditSearchParams,
} from "@/lib/search-params/audit"
import { tablePendingClass } from "@/lib/search-params/shared"
import { DataTablePagination } from "@/components/shared/data-table-pagination"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/lib/format-date"

const ALL = "ALL"

const INTEGRITY_ACTIONS = new Set(["SEB_INTEGRITY_DENIED", "SEB_ACCESS_DENIED"])

const pad = (n: number) => String(n).padStart(2, "0")

function parseDateParam(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function toDateParam(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

interface AuditLogUser {
  id: string
  name: string
  email: string
}

interface AuditLogExam {
  id: string
  title: string
}

interface AuditLogRow {
  id: string
  action: string
  entityType: string
  entityId: string
  metadata: Record<string, unknown> | null
  ipAddress: string | null
  userAgent: string | null
  timestamp: string
  user: AuditLogUser | null
  exam: AuditLogExam | null
}

interface Props {
  admin?: boolean
  logs: AuditLogRow[]
  total: number
  limit: number
  exams?: AuditLogExam[]
  users?: AuditLogUser[]
}

export function AuditLogTable({
  admin = false,
  logs,
  total,
  limit,
  exams = [],
  users = [],
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [filters, setFilters] = useQueryStates(auditSearchParams, {
    startTransition,
  })
  const [exporting, setExporting] = useState(false)
  const totalPages = Math.ceil(total / limit)

  const { examId, action, userId, from, to, ip } = filters

  const hasFilters = Boolean(examId || action || userId || from || to || ip)

  async function handleExport() {
    setExporting(true)
    try {
      const query = serializeAuditSearchParams({
        examId,
        action,
        userId,
        from,
        to,
        ip,
      })
      // The route picks the system-wide scope only when asked: an admin
      // exporting from the teacher page must get the rows that page shows.
      const scope = admin ? `${query ? "&" : "?"}scope=admin` : ""
      const res = await fetch(`/api/audit/export${query}${scope}`)
      if (!res.ok) {
        toast.error("Export fehlgeschlagen")
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Audit-Log exportiert")
    } finally {
      setExporting(false)
    }
  }

  const actionOptions = admin
    ? Object.keys(AUDIT_ACTION_LABELS)
    : EXAM_SCOPED_AUDIT_ACTIONS

  return (
    <div className={cn("space-y-4", tablePendingClass(isPending))}>
      <div className="flex flex-wrap items-center gap-3">
        {!admin && (
          <Combobox
            value={examId || ALL}
            onValueChange={(value) =>
              setFilters({
                examId: value === ALL ? "" : (value ?? ""),
                page: 1,
              })
            }
          >
            <ComboboxInput
              aria-label="Nach Prüfung filtern"
              placeholder="Alle Prüfungen"
              className="w-[220px]"
            />
            <ComboboxContent>
              <ComboboxList>
                <ComboboxItem value={ALL}>Alle Prüfungen</ComboboxItem>
                {exams.map((e) => (
                  <ComboboxItem key={e.id} value={e.id}>
                    {e.title}
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        )}

        <Select
          value={action || ALL}
          onValueChange={(value) =>
            setFilters({ action: value === ALL ? "" : value, page: 1 })
          }
        >
          <SelectTrigger className="w-[240px]" aria-label="Nach Aktion filtern">
            <SelectValue placeholder="Alle Aktionen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Aktionen</SelectItem>
            {actionOptions.map((a) => (
              <SelectItem key={a} value={a}>
                {AUDIT_ACTION_LABELS[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {users.length > 0 && (
          <Select
            value={userId || ALL}
            onValueChange={(value) =>
              setFilters({ userId: value === ALL ? "" : value, page: 1 })
            }
          >
            <SelectTrigger
              className="w-[220px]"
              aria-label="Nach Benutzer filtern"
            >
              <SelectValue placeholder="Alle Benutzer" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Alle Benutzer</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-[220px] justify-start font-normal"
              aria-label="Von Datum"
            >
              <CalendarIcon data-icon="inline-start" />
              {from
                ? new Date(`${from}T00:00:00`).toLocaleDateString("de-CH")
                : "Von Datum"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={parseDateParam(from)}
              onSelect={(date) => {
                if (date === undefined) {
                  setFilters({ from: "", page: 1 })
                  return
                }
                setFilters({ from: toDateParam(date), page: 1 })
              }}
            />
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="w-[220px] justify-start font-normal"
              aria-label="Bis Datum"
            >
              <CalendarIcon data-icon="inline-start" />
              {to
                ? new Date(`${to}T00:00:00`).toLocaleDateString("de-CH")
                : "Bis Datum"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={parseDateParam(to)}
              onSelect={(date) => {
                if (date === undefined) {
                  setFilters({ to: "", page: 1 })
                  return
                }
                setFilters({ to: toDateParam(date), page: 1 })
              }}
            />
          </PopoverContent>
        </Popover>

        <input
          value={ip}
          onChange={(e) =>
            setFilters(
              { ip: e.target.value, page: 1 },
              { limitUrlUpdates: debounce(400) }
            )
          }
          placeholder="IP-Adresse filtern…"
          aria-label="Nach IP-Adresse filtern"
          className="h-9 w-[180px] rounded-md border border-input bg-background px-3 text-sm"
        />

        <div className="ml-auto flex items-center gap-2">
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setFilters({
                  examId: "",
                  action: "",
                  userId: "",
                  from: "",
                  to: "",
                  ip: "",
                  page: 1,
                })
              }
            >
              Filter zurücksetzen
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Exportieren
          </Button>
        </div>
      </div>

      {logs.length === 0 ? (
        <Empty className="border bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollText />
            </EmptyMedia>
            <EmptyTitle>Keine Einträge gefunden</EmptyTitle>
            <EmptyDescription>
              {hasFilters
                ? "Keine Audit-Log-Einträge entsprechen den aktuellen Filtern."
                : admin
                  ? "Noch keine protokollierten Aktionen im System."
                  : "Noch keine protokollierten Aktionen zu Ihren Prüfungen."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Zeitpunkt</TableHead>
                  <TableHead>Aktion</TableHead>
                  {!admin && <TableHead>Prüfung</TableHead>}
                  <TableHead>Ausgeführt von</TableHead>
                  <TableHead>IP</TableHead>
                  {admin && <TableHead>User-Agent</TableHead>}
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell
                      className="text-sm whitespace-nowrap text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {formatDateTime(log.timestamp)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          INTEGRITY_ACTIONS.has(log.action)
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {auditActionLabel(log.action)}
                      </Badge>
                    </TableCell>
                    {!admin && (
                      <TableCell className="text-sm">
                        {log.exam?.title ?? "—"}
                      </TableCell>
                    )}
                    <TableCell className="text-sm">
                      {log.user ? `${log.user.name} (${log.user.email})` : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {log.ipAddress ?? "—"}
                    </TableCell>
                    {admin && (
                      <TableCell
                        className="max-w-[160px] truncate font-mono text-xs text-muted-foreground"
                        title={log.userAgent ?? undefined}
                      >
                        {log.userAgent ?? "—"}
                      </TableCell>
                    )}
                    <TableCell
                      className="max-w-xs truncate font-mono text-xs text-muted-foreground"
                      title={
                        log.metadata ? JSON.stringify(log.metadata) : undefined
                      }
                    >
                      {log.metadata ? JSON.stringify(log.metadata) : "—"}
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
            label="Einträgen"
            onPageChange={(p) => setFilters({ page: p })}
          />
        </>
      )}
    </div>
  )
}
