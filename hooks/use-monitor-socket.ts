"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"

interface Envelope {
  type: string
  id?: string
  data?: unknown
}

interface MonitorUpdateData {
  sessionId: string
  patch: Record<string, unknown>
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

function wsBaseUrl(): string {
  return process.env.NEXT_PUBLIC_WS_URL ?? ""
}

/**
 * Realtime transport for the teacher's live monitor view of one exam.
 * `onSnapshot`/`onUpdate` let the caller (LiveMonitor) apply deltas on top
 * of its existing REST-polled state, which stays as the fallback whenever
 * the socket is closed.
 */
export function useMonitorSocket<TSnapshotSession>({
  examId,
  enabled,
  onSnapshot,
  onUpdate,
}: {
  examId: string
  enabled: boolean
  onSnapshot: (sessions: TSnapshotSession[]) => void
  onUpdate: (update: MonitorUpdateData) => void
}) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectDelayRef = useRef(RECONNECT_MIN_MS)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closedByUsRef = useRef(false)
  const onSnapshotRef = useRef(onSnapshot)
  const onUpdateRef = useRef(onUpdate)

  useLayoutEffect(() => {
    onSnapshotRef.current = onSnapshot
    onUpdateRef.current = onUpdate
  })

  useEffect(() => {
    if (!enabled) return
    closedByUsRef.current = false

    function connect() {
      const base = wsBaseUrl() || window.location.origin.replace(/^http/, "ws")
      const ws = new WebSocket(`${base}/ws/monitor/${examId}`)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        reconnectDelayRef.current = RECONNECT_MIN_MS
      }

      ws.onmessage = (event) => {
        let env: Envelope
        try {
          env = JSON.parse(event.data)
        } catch {
          return
        }
        if (env.type === "monitor:snapshot") {
          onSnapshotRef.current(env.data as TSnapshotSession[])
        } else if (env.type === "monitor:update") {
          onUpdateRef.current(env.data as MonitorUpdateData)
        }
      }

      ws.onclose = () => {
        setConnected(false)
        if (closedByUsRef.current) return
        const delay = reconnectDelayRef.current
        const jitter = delay * 0.2 * Math.random()
        reconnectTimerRef.current = setTimeout(connect, delay + jitter)
        reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      closedByUsRef.current = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [examId, enabled])

  return { connected }
}
