"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  ArrowLeft,
  Clock,
  Loader2,
  Lock,
  LockOpen,
  Accessibility,
  TimerReset,
  StopCircle,
  ShieldAlert,
  Presentation,
  RefreshCw,
  Wifi,
  WifiOff,
  Users,
  ShieldCheck,
  Play,
} from "lucide-react"
import { apiMutateToast } from "@/lib/api-mutate-toast"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconCrossfade } from "@/components/ui/icon-crossfade"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ExamStatusBadge } from "@/components/exams/exam-status-badge"
import { AccessCodeChip } from "@/components/exams/access-code-chip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { isActive, isSubmitted, isWaiting } from "@/lib/session-state"

import { useMonitorSocket } from "@/hooks/use-monitor-socket"
import { useClock } from "@/hooks/use-clock"
import { formatTime } from "@/lib/format-date"
import {
  INTEGRITY_KIND_LABELS,
  applyMonitorPatch,
  mergeKnownPatchKeys,
  type IntegrityEventKind,
  type MonitorSession,
  type MonitorSessionPatch,
} from "@/lib/monitor-patch"
import {
  getMonitorConnectionState,
  getMonitorAttentionReasons,
  partitionMonitorSessions,
  type MonitorAttentionReason,
} from "@/lib/monitor-attention"

const POLL_INTERVAL_MS = 5_000
const POLL_INTERVAL_MS_WS_OPEN = 30_000

type PendingAction = "nam" | "extend" | "lock" | "unlock"

const STATUS_LABELS: Record<string, string> = {
  WAITING: "Im Warteraum",
  IN_PROGRESS: "Läuft",
  SUBMITTED: "Abgegeben",
  AUTO_SUBMITTED: "Automatisch abgegeben",
  LOCKED: "Gesperrt",
}

const ATTENTION_REASON_LABELS: Record<MonitorAttentionReason, string> = {
  DISCONNECTED: "Verbindung getrennt",
  LOCKED: "Sitzung gesperrt",
  SEB_INTEGRITY: "SEB prüfen",
  DEVICE_REPLACED: "Weiteres Gerät",
  INTEGRITY_EVENTS: "Auffälligkeiten",
  LOW_TIME: "Wenig Zeit",
}

function getSessionChangeSignature(
  session: MonitorSession,
  nowMs: number,
  questionCount: number
): string {
  return [
    session.status,
    session.sebIntegrityFlagged ? "1" : "0",
    session.deviceReplacedCount ?? 0,
    session.timeExtensionMin,
    session.integrityEventCount,
    getMonitorAttentionReasons(session, nowMs, questionCount).join(","),
  ].join("|")
}

interface IntegrityEvent {
  id: string
  kind: IntegrityEventKind
  detail: string | null
  createdAt: string
  clientTime: string
}

interface MonitorData {
  exam: {
    id: string
    title: string
    status: string
    accessCode: string
    timeLimitMin: number
    /** Shared start: students wait until the teacher presses Start here. */
    waitingRoom: boolean
    questionCount: number
  }
  sessions: MonitorSession[]
  serverNow: string
}

export function LiveMonitor({ examId }: { examId: string }) {
  const router = useRouter()
  const [data, setData] = useState<MonitorData | null>(null)
  const [loadError, setLoadError] = useState("")
  const [extendTarget, setExtendTarget] = useState<MonitorSession | null>(null)
  const [extendMinutes, setExtendMinutes] = useState("10")
  const [bulkExtendOpen, setBulkExtendOpen] = useState(false)
  const [bulkExtending, setBulkExtending] = useState(false)
  const [codeDialogOpen, setCodeDialogOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [attentionNow, setAttentionNow] = useState(() => Date.now())
  const [pendingActions, setPendingActions] = useState<
    Record<string, PendingAction>
  >({})
  const [clockOffset, setClockOffset] = useState(0)
  const clockOffsetRef = useRef(0)
  // Backs "last seen" relative-time text. Updated only when the session list
  // actually changes (poll/WS), not on a per-second tick — otherwise every
  // memoized SessionRow would get a new prop every second and re-render
  // regardless of memo(), defeating the point of memoizing rows at all.
  const [serverNow, setServerNow] = useState(0)
  const [integrityTarget, setIntegrityTarget] = useState<MonitorSession | null>(
    null
  )
  const [integrityEvents, setIntegrityEvents] = useState<IntegrityEvent[]>([])
  const [integrityLoading, setIntegrityLoading] = useState(false)
  const integrityRequestRef = useRef<string | null>(null)
  // Coalesces bursty WebSocket patches (a class typing produces ~one
  // monitor:update per student per second) into a single setState, so the
  // table re-renders at most ~4x/s instead of per message. Only known patch
  // keys ever land here — see mergeKnownPatchKeys.
  const pendingUpdatesRef = useRef<Map<string, MonitorSessionPatch>>(new Map())
  const flushUpdatesRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousSessionSignaturesRef = useRef<Map<string, string>>(new Map())
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashFrameRef = useRef<number | null>(null)
  const [flashingSessionIds, setFlashingSessionIds] = useState<
    ReadonlySet<string>
  >(new Set())

  useEffect(() => {
    const attentionTimer = setInterval(
      () => setAttentionNow(Date.now()),
      15_000
    )
    return () => {
      clearInterval(attentionTimer)
      if (flushUpdatesRef.current !== null)
        clearTimeout(flushUpdatesRef.current)
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
      if (flashFrameRef.current !== null)
        cancelAnimationFrame(flashFrameRef.current)
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/exams/${examId}/sessions`)
      const d = await res.json()
      if (!res.ok) {
        setLoadError(d.error?.message ?? "Laden fehlgeschlagen")
        return
      }
      const offset = new Date(d.serverNow).getTime() - Date.now()
      clockOffsetRef.current = offset
      setClockOffset(offset)
      setServerNow(Date.now() + offset)
      setData(d)
      setLoadError("")
      setLastUpdatedAt(Date.now())
    } catch {
      setLoadError(
        "Die aktuellen Sitzungsdaten konnten nicht geladen werden. Die letzte Ansicht bleibt sichtbar."
      )
    }
  }, [examId])

  const socket = useMonitorSocket<MonitorSession>({
    examId,
    enabled: data !== null,
    onSnapshot: useCallback((sessions) => {
      setData((prev) => (prev ? { ...prev, sessions } : prev))
      setServerNow(Date.now() + clockOffsetRef.current)
      setLastUpdatedAt(Date.now())
      setLoadError("")
    }, []),
    onUpdate: useCallback(({ sessionId, patch }) => {
      // Unknown keys no-op instead of poisoning the session state; the
      // coalescing below then only ever sees known keys.
      const knownPatch = mergeKnownPatchKeys(patch)
      const pending = pendingUpdatesRef.current
      const existing = pending.get(sessionId)
      pending.set(
        sessionId,
        existing ? applyMonitorPatch(existing, knownPatch) : knownPatch
      )
      if (flushUpdatesRef.current !== null) return
      flushUpdatesRef.current = setTimeout(() => {
        flushUpdatesRef.current = null
        const updates = pendingUpdatesRef.current
        pendingUpdatesRef.current = new Map()
        setData((prev) => {
          if (!prev || updates.size === 0) return prev
          let changed = false
          const sessions = prev.sessions.map((s) => {
            const patch = updates.get(s.id)
            if (!patch) return s
            changed = true
            return applyMonitorPatch(s, patch)
          })
          return changed ? { ...prev, sessions } : prev
        })
        setServerNow(Date.now() + clockOffsetRef.current)
        setLastUpdatedAt(Date.now())
        setLoadError("")
      }, 250)
    }, []),
  })

  useEffect(() => {
    if (!data) return

    const nowMs = Date.now() + clockOffset
    const changedSessionIds = new Set<string>()
    const nextSignatures = new Map<string, string>()

    for (const session of data.sessions) {
      const signature = getSessionChangeSignature(
        session,
        nowMs,
        data.exam.questionCount
      )
      const previousSignature = previousSessionSignaturesRef.current.get(
        session.id
      )
      nextSignatures.set(session.id, signature)
      if (previousSignature !== undefined && previousSignature !== signature) {
        changedSessionIds.add(session.id)
      }
    }

    previousSessionSignaturesRef.current = nextSignatures
    if (changedSessionIds.size === 0) return

    if (flashFrameRef.current !== null)
      cancelAnimationFrame(flashFrameRef.current)
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)

    // Remove the animation class in one frame and re-add it in the next:
    // that reliably restarts the CSS animation when a session changes again
    // before its previous flash has completed.
    //
    // Both updates run inside a frame callback rather than one of them in the
    // effect body. A synchronous setState here would be a cascading render
    // (react-hooks/set-state-in-effect), and collapsing the two into a single
    // callback would not work either: React batches them into one update, so
    // the class would never leave the DOM and the animation would not retrigger.
    flashFrameRef.current = requestAnimationFrame(() => {
      setFlashingSessionIds((previous) => {
        const next = new Set(previous)
        for (const sessionId of changedSessionIds) next.delete(sessionId)
        return next
      })

      flashFrameRef.current = requestAnimationFrame(() => {
        flashFrameRef.current = null
        setFlashingSessionIds((previous) => {
          const next = new Set(previous)
          for (const sessionId of changedSessionIds) next.add(sessionId)
          return next
        })
        flashTimerRef.current = setTimeout(() => {
          flashTimerRef.current = null
          setFlashingSessionIds(new Set())
        }, 700)
      })
    })
  }, [data, clockOffset])

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0)
    const poll = setInterval(
      () => void refresh(),
      socket.connected ? POLL_INTERVAL_MS_WS_OPEN : POLL_INTERVAL_MS
    )
    return () => {
      clearTimeout(initial)
      clearInterval(poll)
    }
  }, [refresh, socket.connected])

  const extend = useCallback(async function extend(
    sessionId: string,
    body: { mode: "NAM" } | { minutes: number }
  ): Promise<boolean> {
    const pendingAction: PendingAction = "mode" in body ? "nam" : "extend"
    setPendingActions((prev) => ({ ...prev, [sessionId]: pendingAction }))
    try {
      const result = await apiMutateToast<{ session: MonitorSession }>(
        `/api/sessions/${sessionId}/extend`,
        {
          body,
          success: `Zeit verlängert (+${
            "mode" in body ? "15 %" : `${body.minutes} Min.`
          })`,
          fallbackError: "Verlängerung fehlgeschlagen",
          networkError: "Verlängerung fehlgeschlagen. Bitte erneut versuchen.",
        }
      )
      if (!result.ok) return false
      setData((prev) =>
        prev
          ? {
              ...prev,
              sessions: prev.sessions.map((session) =>
                session.id === sessionId
                  ? { ...session, ...result.data.session }
                  : session
              ),
            }
          : prev
      )
      return true
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev }
        delete next[sessionId]
        return next
      })
    }
  }, [])

  const toggleLock = useCallback(async function toggleLock(
    s: MonitorSession
  ): Promise<void> {
    const locked = s.status !== "LOCKED"
    setPendingActions((prev) => ({
      ...prev,
      [s.id]: locked ? "lock" : "unlock",
    }))
    try {
      const result = await apiMutateToast<{ session: MonitorSession }>(
        `/api/sessions/${s.id}/lock`,
        {
          body: { locked },
          success: locked ? "Sitzung gesperrt" : "Sitzung entsperrt",
          fallbackError: "Aktion fehlgeschlagen",
          networkError: "Aktion fehlgeschlagen. Bitte erneut versuchen.",
        }
      )
      if (!result.ok) return
      setData((prev) =>
        prev
          ? {
              ...prev,
              sessions: prev.sessions.map((session) =>
                session.id === s.id
                  ? { ...session, status: result.data.session.status }
                  : session
              ),
            }
          : prev
      )
    } finally {
      setPendingActions((prev) => {
        const next = { ...prev }
        delete next[s.id]
        return next
      })
    }
  }, [])

  const requestExtend = useCallback(function requestExtend(s: MonitorSession) {
    setExtendMinutes("10")
    setExtendTarget(s)
  }, [])

  async function handleManualExtend(): Promise<void> {
    const minutes = parseInt(extendMinutes)
    if (
      !extendTarget ||
      !Number.isInteger(minutes) ||
      minutes < 1 ||
      minutes > 240
    ) {
      toast.error("Bitte 1–240 Minuten angeben")
      return
    }
    if (await extend(extendTarget.id, { minutes })) {
      setExtendTarget(null)
    }
  }

  async function handleBulkExtend(): Promise<void> {
    const minutes = parseInt(extendMinutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      toast.error("Bitte 1–240 Minuten angeben")
      return
    }
    setBulkExtending(true)
    try {
      const result = await apiMutateToast<{
        sessions: MonitorSession[]
        sessionsAffected: number
      }>(`/api/exams/${examId}/extend`, {
        body: { minutes },
        success: (d) =>
          `Zeit für ${d.sessionsAffected} Sitzung(en) verlängert (+${minutes} Min.)`,
        fallbackError: "Verlängerung fehlgeschlagen",
        networkError: "Verlängerung fehlgeschlagen. Bitte erneut versuchen.",
      })
      if (!result.ok) return
      setData((previous) =>
        previous
          ? {
              ...previous,
              sessions: previous.sessions.map((session) => {
                const updated = result.data.sessions.find(
                  (candidate) => candidate.id === session.id
                )
                return updated ? { ...session, ...updated } : session
              }),
            }
          : previous
      )
      setBulkExtendOpen(false)
    } finally {
      setBulkExtending(false)
    }
  }

  const openIntegrityEvents = useCallback(async function openIntegrityEvents(
    s: MonitorSession
  ) {
    setIntegrityTarget(s)
    setIntegrityEvents([])
    setIntegrityLoading(true)
    integrityRequestRef.current = s.id
    try {
      const res = await fetch(`/api/sessions/${s.id}/integrity-events`)
      const d = await res.json()
      // A slow fetch for a previously opened session must not overwrite the
      // rows shown under another student's name.
      if (integrityRequestRef.current !== s.id) return
      setIntegrityEvents(res.ok ? d.events : [])
    } catch {
      if (integrityRequestRef.current === s.id) setIntegrityEvents([])
    } finally {
      if (integrityRequestRef.current === s.id) setIntegrityLoading(false)
    }
  }, [])

  async function closeExam() {
    setClosing(true)
    try {
      const result = await apiMutateToast<{ forcedSubmissions: number }>(
        `/api/exams/${examId}/close`,
        {
          success: (d) =>
            d.forcedSubmissions > 0
              ? `Prüfung beendet — ${d.forcedSubmissions} offene Sitzung(en) automatisch abgegeben`
              : "Prüfung beendet",
          fallbackError: "Beenden fehlgeschlagen",
        }
      )
      if (!result.ok) return
      router.push(`/dashboard/teacher/grades/${examId}`)
    } finally {
      setClosing(false)
      setCloseOpen(false)
    }
  }

  async function startExam() {
    setStarting(true)
    try {
      const result = await apiMutateToast<{ startedWaiting: number }>(
        `/api/exams/${examId}/activate`,
        {
          success: (d) =>
            d.startedWaiting > 0
              ? `Prüfung gestartet — ${d.startedWaiting} aus dem Warteraum beginnen in 10 Sekunden`
              : "Prüfung gestartet",
          fallbackError: "Starten fehlgeschlagen",
        }
      )
      if (result.ok) await refresh()
    } finally {
      setStarting(false)
      setStartOpen(false)
    }
  }

  if (loadError && !data) {
    return <div className="p-6 text-sm text-destructive">{loadError}</div>
  }
  if (!data) {
    return (
      <div className="flex min-h-[50svh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const active = data.sessions.filter((s) => isActive(s.status)).length
  const waiting = data.sessions.filter((s) => isWaiting(s.status)).length
  const awaitingStart =
    data.exam.status === "PUBLISHED" && data.exam.waitingRoom
  const sessionGroups = partitionMonitorSessions(
    data.sessions,
    attentionNow + clockOffset,
    data.exam.questionCount
  )
  const attentionItems = sessionGroups.attention
  const regularItems = sessionGroups.rest.map((session) => ({
    session,
    reasons: [] as MonitorAttentionReason[],
  }))

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-1" />
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Zurück zur Prüfungsauswahl"
          >
            <Link
              href="/dashboard/teacher/monitor"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{data.exam.title}</h1>
            <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <ExamStatusBadge status={data.exam.status as never} />
              <span>·</span>
              <span>
                {awaitingStart
                  ? `${waiting} im Warteraum`
                  : `${active} aktiv / ${data.sessions.length} Sitzungen`}
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ConnectionStatus
            connected={socket.connected}
            lastUpdatedAt={lastUpdatedAt}
          />
          <AccessCodeChip code={data.exam.accessCode} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCodeDialogOpen(true)}
          >
            <Presentation className="h-4 w-4" />
            Code anzeigen
          </Button>
          {awaitingStart && (
            <Button
              onClick={() => setStartOpen(true)}
              disabled={starting}
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              <Play className="h-4 w-4" />
              Prüfung starten
            </Button>
          )}
          {data.exam.status === "ACTIVE" && (
            <Button
              variant="outline"
              onClick={() => {
                setExtendMinutes("10")
                setBulkExtendOpen(true)
              }}
              disabled={active === 0}
            >
              <TimerReset className="h-4 w-4" />
              Zeit für alle verlängern
            </Button>
          )}
          {data.exam.status === "ACTIVE" && (
            <Button variant="destructive" onClick={() => setCloseOpen(true)}>
              <StopCircle className="h-4 w-4" />
              Prüfung beenden
            </Button>
          )}
        </div>
      </div>

      {loadError && (
        <Alert variant="destructive">
          <WifiOff className="h-4 w-4" />
          <AlertTitle>Aktualisierung unterbrochen</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" />
              Jetzt aktualisieren
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="hidden rounded-lg border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Schüler:in</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Fortschritt</TableHead>
              <TableHead>Restzeit</TableHead>
              <TableHead>Zuletzt aktiv</TableHead>
              <TableHead>Auffälligkeiten</TableHead>
              <TableHead className="text-right">Aktionen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.sessions.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="p-0">
                  <NoParticipantsEmpty
                    examActive={data.exam.status === "ACTIVE"}
                    waitingRoomOpen={awaitingStart}
                    accessCode={data.exam.accessCode}
                    onShowCode={() => setCodeDialogOpen(true)}
                  />
                </TableCell>
              </TableRow>
            )}
            {attentionItems.length > 0 && (
              <SessionGroupHeading
                title="Benötigt Aufmerksamkeit"
                count={attentionItems.length}
              />
            )}
            {attentionItems.map(({ session, reasons }) => (
              <SessionRow
                key={session.id}
                session={session}
                reasons={reasons}
                questionCount={data.exam.questionCount}
                serverNow={serverNow}
                clockOffset={clockOffset}
                highlighted={flashingSessionIds.has(session.id)}
                pendingAction={pendingActions[session.id]}
                onExtend={extend}
                onRequestExtend={requestExtend}
                onToggleLock={toggleLock}
                onOpenIntegrity={openIntegrityEvents}
              />
            ))}
            {regularItems.length > 0 && attentionItems.length > 0 && (
              <SessionGroupHeading
                title="Weitere Teilnehmende"
                count={regularItems.length}
              />
            )}
            {regularItems.map(({ session, reasons }) => (
              <SessionRow
                key={session.id}
                session={session}
                reasons={reasons}
                questionCount={data.exam.questionCount}
                serverNow={serverNow}
                clockOffset={clockOffset}
                highlighted={flashingSessionIds.has(session.id)}
                pendingAction={pendingActions[session.id]}
                onExtend={extend}
                onRequestExtend={requestExtend}
                onToggleLock={toggleLock}
                onOpenIntegrity={openIntegrityEvents}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-5 md:hidden">
        {data.sessions.length === 0 && (
          <NoParticipantsEmpty
            className="rounded-lg border border-dashed"
            examActive={data.exam.status === "ACTIVE"}
            waitingRoomOpen={awaitingStart}
            accessCode={data.exam.accessCode}
            onShowCode={() => setCodeDialogOpen(true)}
          />
        )}
        {attentionItems.length > 0 && (
          <MobileSessionGroup
            title="Benötigt Aufmerksamkeit"
            items={attentionItems}
            questionCount={data.exam.questionCount}
            serverNow={serverNow}
            clockOffset={clockOffset}
            pendingActions={pendingActions}
            onExtend={extend}
            onRequestExtend={requestExtend}
            onToggleLock={toggleLock}
            onOpenIntegrity={openIntegrityEvents}
          />
        )}
        {regularItems.length > 0 && (
          <MobileSessionGroup
            title={
              attentionItems.length > 0
                ? "Weitere Teilnehmende"
                : "Teilnehmende"
            }
            items={regularItems}
            questionCount={data.exam.questionCount}
            serverNow={serverNow}
            clockOffset={clockOffset}
            pendingActions={pendingActions}
            onExtend={extend}
            onRequestExtend={requestExtend}
            onToggleLock={toggleLock}
            onOpenIntegrity={openIntegrityEvents}
          />
        )}
      </div>

      <Dialog open={codeDialogOpen} onOpenChange={setCodeDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Zugangscode</DialogTitle>
            <DialogDescription>
              Zeigen Sie diesen Code im Raum oder kopieren Sie ihn für Ihre
              Teilnehmenden.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-56 items-center justify-center rounded-xl border bg-muted/30 p-8">
            <AccessCodeChip
              code={data.exam.accessCode}
              className="px-6 py-4 text-4xl tracking-[0.3em] sm:text-6xl"
            />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={extendTarget !== null}
        onOpenChange={(open) => {
          if (!open && extendTarget && !pendingActions[extendTarget.id]) {
            setExtendTarget(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zeit verlängern</DialogTitle>
            <DialogDescription>
              Zusätzliche Minuten für {extendTarget?.student.name} (z. B. bei
              technischen Problemen).
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Label htmlFor="extend-minutes" className="shrink-0">
              Minuten
            </Label>
            <Input
              id="extend-minutes"
              type="number"
              min={1}
              max={240}
              value={extendMinutes}
              onChange={(e) => setExtendMinutes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setExtendTarget(null)}
              disabled={
                !!extendTarget && pendingActions[extendTarget.id] === "extend"
              }
            >
              Abbrechen
            </Button>
            <Button
              onClick={() => void handleManualExtend()}
              disabled={
                !!extendTarget && pendingActions[extendTarget.id] === "extend"
              }
            >
              {extendTarget && pendingActions[extendTarget.id] === "extend" && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Verlängern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={bulkExtendOpen} onOpenChange={setBulkExtendOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Zeit für alle verlängern</DialogTitle>
            <DialogDescription>
              Alle derzeit offenen Sitzungen ({active}) erhalten dieselbe
              zusätzliche Zeit. Bereits abgegebene Sitzungen bleiben
              unverändert.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3">
            <Label htmlFor="bulk-extend-minutes" className="shrink-0">
              Minuten
            </Label>
            <Input
              id="bulk-extend-minutes"
              type="number"
              min={1}
              max={240}
              value={extendMinutes}
              onChange={(e) => setExtendMinutes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkExtendOpen(false)}
              disabled={bulkExtending}
            >
              Abbrechen
            </Button>
            <Button
              onClick={() => void handleBulkExtend()}
              disabled={bulkExtending}
            >
              {bulkExtending && <Loader2 className="h-4 w-4 animate-spin" />}Für
              alle verlängern
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={startOpen} onOpenChange={setStartOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prüfung starten?</DialogTitle>
            <DialogDescription>
              {waiting === 1
                ? "1 Person im Warteraum beginnt"
                : `${waiting} Personen im Warteraum beginnen`}{" "}
              nach einem Countdown von 10 Sekunden gleichzeitig und erhalten die
              volle Dauer von {data.exam.timeLimitMin} Minuten. Wer später
              beitritt, erhält die volle Dauer ab dem eigenen Beitritt.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setStartOpen(false)}
              disabled={starting}
            >
              Abbrechen
            </Button>
            <Button
              onClick={startExam}
              disabled={starting}
              className="bg-success text-success-foreground hover:bg-success/90"
            >
              {starting && <Loader2 className="h-4 w-4 animate-spin" />}
              Jetzt starten
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Prüfung beenden?</DialogTitle>
            <DialogDescription>
              Alle noch offenen Sitzungen ({active}) werden automatisch
              abgegeben. Dieser Schritt kann nicht rückgängig gemacht werden.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCloseOpen(false)}
              disabled={closing}
            >
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={closeExam}
              disabled={closing}
            >
              {closing && <Loader2 className="h-4 w-4 animate-spin" />}
              Endgültig beenden
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={integrityTarget !== null}
        onOpenChange={(o) => !o && setIntegrityTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              Auffälligkeiten — {integrityTarget?.student.name}
            </DialogTitle>
            <DialogDescription>
              Client-seitig erkannte Signale (Tab-Wechsel, Fenster verlassen,
              blockierte Kopier-/Einfügeversuche u. ä.), mit der Empfangszeit
              des Servers. Kein Beweis für Täuschung, aber ein Hinweis für
              Rückfragen.
            </DialogDescription>
          </DialogHeader>
          {integrityLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : integrityEvents.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldCheck />
                </EmptyMedia>
                <EmptyTitle>Keine Auffälligkeiten</EmptyTitle>
                <EmptyDescription>
                  Für diese Sitzung wurden bisher keine Signale erfasst.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto text-sm">
              {integrityEvents.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <span>{INTEGRITY_KIND_LABELS[e.kind] ?? e.kind}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatTime(e.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function NoParticipantsEmpty({
  examActive,
  waitingRoomOpen,
  accessCode,
  onShowCode,
  className,
}: {
  examActive: boolean
  waitingRoomOpen: boolean
  accessCode: string
  onShowCode: () => void
  className?: string
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Users />
        </EmptyMedia>
        <EmptyTitle>Noch keine Teilnehmenden</EmptyTitle>
        <EmptyDescription>
          {waitingRoomOpen
            ? "Teilen Sie den Zugangscode — wer beitritt, wartet hier im Warteraum, bis Sie die Prüfung starten."
            : examActive
              ? "Teilen Sie den Zugangscode mit der Klasse — beigetretene Teilnehmende erscheinen hier automatisch."
              : "Zu dieser Prüfung ist niemand beigetreten. Starten Sie die Prüfung, damit Teilnehmende mit dem Zugangscode beitreten können."}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <AccessCodeChip code={accessCode} />
        <Button variant="outline" size="sm" onClick={onShowCode}>
          <Presentation className="h-4 w-4" />
          Code anzeigen
        </Button>
      </div>
    </Empty>
  )
}

function ConnectionStatus({
  connected,
  lastUpdatedAt,
}: {
  connected: boolean
  lastUpdatedAt: number | null
}) {
  const nowMs = useClock()
  const state = getMonitorConnectionState({ connected, lastUpdatedAt, nowMs })
  const config = {
    LIVE: {
      label: "Live verbunden",
      icon: Wifi,
      className: "border-green-600/30 bg-green-600/10 text-green-700",
    },
    POLLING: {
      label: "Intervall-Aktualisierung",
      icon: RefreshCw,
      className: "border-amber-600/30 bg-amber-600/10 text-amber-700",
    },
    STALE: {
      label: "Daten veraltet",
      icon: WifiOff,
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    },
  }[state]
  const Icon = config.icon

  return (
    <Badge variant="outline" className={config.className} aria-live="polite">
      {/* Keyed on the state so the icon and its label fade in together when
          the connection flips, instead of snapping mid-sentence. */}
      <span
        key={state}
        className="inline-flex animate-in items-center gap-1 duration-[var(--duration-fast)] fade-in-0"
      >
        <Icon className="h-3.5 w-3.5" />
        {config.label}
      </span>
    </Badge>
  )
}

function SessionGroupHeading({
  title,
  count,
}: {
  title: string
  count: number
}) {
  return (
    <TableRow className="bg-muted/50 hover:bg-muted/50">
      <TableCell colSpan={7} className="py-2 font-medium">
        <span>{title}</span>
        <Badge variant="secondary" className="ml-2 tabular-nums">
          {count}
        </Badge>
      </TableCell>
    </TableRow>
  )
}

function AttentionBadges({ reasons }: { reasons: MonitorAttentionReason[] }) {
  if (reasons.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reasons.map((reason) => (
        <Badge
          key={reason}
          variant={reason === "LOW_TIME" ? "outline" : "destructive"}
          className="h-5 text-[10px]"
        >
          {ATTENTION_REASON_LABELS[reason]}
        </Badge>
      ))}
    </div>
  )
}

function SessionStatusBadges({ session }: { session: MonitorSession }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge
        variant={session.status === "LOCKED" ? "destructive" : "secondary"}
      >
        {STATUS_LABELS[session.status] ?? session.status}
      </Badge>
      {session.timeExtensionMin > 0 && (
        <Badge variant="outline">+{session.timeExtensionMin} Min.</Badge>
      )}
      {session.namApplied && <Badge variant="outline">NAM gewährt</Badge>}
      {session.sebIntegrityFlagged && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex outline-none">
              <Badge variant="destructive" className="cursor-help">
                {session.sebIntegrityReason === "bek_disappeared"
                  ? "SEB nicht mehr gesendet"
                  : "SEB geändert"}
              </Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64 font-normal">
            {session.sebIntegrityReason === "bek_disappeared"
              ? "Der Safe Exam Browser wird von diesem Gerät nicht mehr gemeldet — möglicherweise wurde in einen normalen Browser gewechselt. Bitte klären Sie die Situation mit der Person."
              : "Die Safe-Exam-Browser-Konfiguration dieses Geräts hat sich während der Prüfung verändert — möglicherweise wurde eine andere Konfiguration geladen. Bitte klären Sie die Situation mit der Person."}
          </TooltipContent>
        </Tooltip>
      )}
      {(session.deviceReplacedCount ?? 0) > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex outline-none">
              <Badge variant="destructive" className="cursor-help">
                Weiteres Gerät ({session.deviceReplacedCount}×)
              </Badge>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-64 font-normal">
            {`Die Prüfung wurde ${session.deviceReplacedCount}-mal in einem anderen Fenster oder auf einem anderen Gerät übernommen. Das kann ein Neustart des Safe Exam Browsers sein – Details im Audit-Log. Bitte klären Sie die Situation mit der Person.`}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function SessionActions({
  session,
  pendingAction,
  onExtend,
  onRequestExtend,
  onToggleLock,
}: {
  session: MonitorSession
  pendingAction?: PendingAction
  onExtend: (
    sessionId: string,
    body: { mode: "NAM" } | { minutes: number }
  ) => Promise<boolean>
  onRequestExtend: (session: MonitorSession) => void
  onToggleLock: (session: MonitorSession) => Promise<void>
}) {
  // A waiting student can already get time grants (they count from the
  // shared start); locking only applies once the exam runs.
  const waitingRoom = session.status === "WAITING"
  const open =
    waitingRoom ||
    session.status === "IN_PROGRESS" ||
    session.status === "DISCONNECTED" ||
    session.status === "LOCKED"
  if (!open) return null

  const busy = pendingAction !== undefined
  const accommodationLabel = session.namApplied
    ? "Nachteilsausgleich bereits gewährt"
    : "Nachteilsausgleich: Prüfungszeit einmalig um 15\u00a0% verlängern"

  return (
    <div className="flex justify-end gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              size="icon"
              variant="ghost"
              disabled={busy || session.namApplied}
              onClick={() => void onExtend(session.id, { mode: "NAM" })}
              aria-label={accommodationLabel}
            >
              <IconCrossfade active={pendingAction === "nam" ? "busy" : "idle"}>
                {pendingAction === "nam" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Accessibility className="h-4 w-4" />
                )}
              </IconCrossfade>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-56 font-normal">
          {accommodationLabel}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              size="icon"
              variant="ghost"
              disabled={busy}
              onClick={() => onRequestExtend(session)}
              aria-label="Zeit verlängern"
            >
              <IconCrossfade
                active={pendingAction === "extend" ? "busy" : "idle"}
              >
                {pendingAction === "extend" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <TimerReset className="h-4 w-4" />
                )}
              </IconCrossfade>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Zeit verlängern</TooltipContent>
      </Tooltip>
      {!waitingRoom && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                size="icon"
                variant="ghost"
                disabled={busy}
                onClick={() => void onToggleLock(session)}
                aria-label={
                  session.status === "LOCKED" ? "Entsperren" : "Sperren"
                }
              >
                <IconCrossfade
                  active={
                    pendingAction === "lock" || pendingAction === "unlock"
                      ? "busy"
                      : session.status === "LOCKED"
                        ? "unlock"
                        : "lock"
                  }
                >
                  {pendingAction === "lock" || pendingAction === "unlock" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : session.status === "LOCKED" ? (
                    <LockOpen className="h-4 w-4" />
                  ) : (
                    <Lock className="h-4 w-4" />
                  )}
                </IconCrossfade>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {session.status === "LOCKED" ? "Entsperren" : "Sperren"}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function MobileSessionGroup({
  title,
  items,
  questionCount,
  serverNow,
  clockOffset,
  pendingActions,
  onExtend,
  onRequestExtend,
  onToggleLock,
  onOpenIntegrity,
}: {
  title: string
  items: {
    session: MonitorSession
    reasons: MonitorAttentionReason[]
  }[]
  questionCount: number
  serverNow: number
  clockOffset: number
  pendingActions: Record<string, PendingAction>
  onExtend: (
    sessionId: string,
    body: { mode: "NAM" } | { minutes: number }
  ) => Promise<boolean>
  onRequestExtend: (session: MonitorSession) => void
  onToggleLock: (session: MonitorSession) => Promise<void>
  onOpenIntegrity: (session: MonitorSession) => void
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="secondary" className="tabular-nums">
          {items.length}
        </Badge>
      </div>
      {items.map(({ session, reasons }) => (
        <article key={session.id} className="space-y-3 rounded-lg border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate font-medium">{session.student.name}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {session.student.email}
              </p>
              <AttentionBadges reasons={reasons} />
            </div>
            <SessionStatusBadges session={session} />
          </div>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Fortschritt</dt>
              <dd className="mt-1 tabular-nums">
                {session.answerCount} / {questionCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Restzeit</dt>
              <dd className="mt-1">
                <RemainingTime session={session} clockOffset={clockOffset} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Zuletzt aktiv</dt>
              <dd className="mt-1 text-xs text-muted-foreground">
                {session.lastSeenAt
                  ? formatRelative(session.lastSeenAt, serverNow)
                  : "—"}
              </dd>
            </div>
          </dl>
          <div className="flex items-center justify-between border-t pt-2">
            {session.integrityEventCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => void onOpenIntegrity(session)}
              >
                <ShieldAlert className="h-3.5 w-3.5" />
                {session.integrityEventCount} Auffälligkeiten
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                Keine Auffälligkeiten
              </span>
            )}
            <SessionActions
              session={session}
              pendingAction={pendingActions[session.id]}
              onExtend={onExtend}
              onRequestExtend={onRequestExtend}
              onToggleLock={onToggleLock}
            />
          </div>
        </article>
      ))}
    </section>
  )
}

const SessionRow = memo(function SessionRow({
  session,
  reasons,
  questionCount,
  serverNow,
  clockOffset,
  highlighted,
  pendingAction,
  onExtend,
  onRequestExtend,
  onToggleLock,
  onOpenIntegrity,
}: {
  session: MonitorSession
  reasons: MonitorAttentionReason[]
  questionCount: number
  serverNow: number
  clockOffset: number
  highlighted: boolean
  pendingAction?: PendingAction
  onExtend: (
    sessionId: string,
    body: { mode: "NAM" } | { minutes: number }
  ) => Promise<boolean>
  onRequestExtend: (session: MonitorSession) => void
  onToggleLock: (session: MonitorSession) => Promise<void>
  onOpenIntegrity: (session: MonitorSession) => void
}) {
  return (
    <TableRow
      className={
        highlighted ? "animate-[monitor-row-flash_700ms_ease-out]" : undefined
      }
    >
      <TableCell>
        <div className="font-medium">{session.student.name}</div>
        <div className="text-xs text-muted-foreground">
          {session.student.email}
        </div>
        <AttentionBadges reasons={reasons} />
      </TableCell>
      <TableCell>
        <SessionStatusBadges session={session} />
      </TableCell>
      <TableCell className="tabular-nums">
        {session.answerCount} / {questionCount}
      </TableCell>
      <TableCell>
        <RemainingTime session={session} clockOffset={clockOffset} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {session.lastSeenAt
          ? formatRelative(session.lastSeenAt, serverNow)
          : "—"}
      </TableCell>
      <TableCell>
        {session.integrityEventCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-destructive hover:text-destructive"
            onClick={() => void onOpenIntegrity(session)}
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            {session.integrityEventCount}
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <SessionActions
          session={session}
          pendingAction={pendingAction}
          onExtend={onExtend}
          onRequestExtend={onRequestExtend}
          onToggleLock={onToggleLock}
        />
      </TableCell>
    </TableRow>
  )
})

const RemainingTime = memo(function RemainingTime({
  session,
  clockOffset,
}: {
  session: MonitorSession
  clockOffset: number
}) {
  const nowMs = useClock() + clockOffset

  if (!session.effectiveEndTime || isSubmitted(session.status)) {
    return <span className="text-muted-foreground">—</span>
  }
  const remaining = Math.max(
    0,
    Math.floor((new Date(session.effectiveEndTime).getTime() - nowMs) / 1000)
  )
  const m = Math.floor(remaining / 60)
  const s = remaining % 60
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono tabular-nums ${
        remaining <= 300 ? "text-destructive" : ""
      }`}
    >
      <Clock className="h-3.5 w-3.5" />
      {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  )
})

function formatRelative(iso: string, serverNow: number): string {
  const sec = Math.max(
    0,
    Math.floor((serverNow - new Date(iso).getTime()) / 1000)
  )
  if (sec < 10) return "gerade eben"
  if (sec < 60) return `vor ${sec} s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `vor ${min} Min.`
  return `vor ${Math.floor(min / 60)} Std.`
}
