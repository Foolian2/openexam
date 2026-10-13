"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { getSebKey, getSebRequestHash } from "@/lib/seb-client"
import type { IntegrityEventKind } from "@/hooks/use-integrity-monitor"

type AnswerContent = unknown

interface AckWaiter {
  resolve: (ok: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

interface Envelope {
  type: string
  id?: string
  data?: unknown
}

interface ControlData {
  action: string
  sessionId?: string
}

interface TimerSyncData {
  effectiveEndTime: string | null
  serverNow: string
}

const ACK_TIMEOUT_MS = 5_000
const PING_INTERVAL_MS = 20_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

// Spread the *first* connection over this window. Students admitted in the
// same second all hydrate the exam page at once and would otherwise complete
// their handshakes in lockstep; a fraction of a second of scatter costs the
// student nothing (answers buffer and fall back to REST until the socket is
// up) and turns a spike of simultaneous upgrades into a trickle. Reconnects
// already jitter via the backoff below — this is the one path that didn't.
const INITIAL_CONNECT_JITTER_MS = 500

function wsBaseUrl(): string {
  return process.env.NEXT_PUBLIC_WS_URL ?? ""
}

/**
 * Realtime transport for one exam-taking session. Falls back gracefully:
 * `sendAnswer` resolves false whenever the socket isn't open or an ack
 * doesn't arrive in time, and the caller (ExamRunner) is expected to retry
 * over REST in that case — this hook never owns the pending-answer queue;
 * that lives in the answer buffer module (lib/answer-buffer.ts).
 */
export function useExamSocket({
  sessionId,
  enabled,
  sebRequired,
  onControl,
  onTimerSync,
  onSebAuthFailed,
}: {
  sessionId: string
  enabled: boolean
  sebRequired: boolean
  onControl: (data: ControlData) => void
  onTimerSync: (data: TimerSyncData) => void
  onSebAuthFailed?: () => void
}) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const ackWaiters = useRef<Map<string, AckWaiter>>(new Map())
  const reconnectDelayRef = useRef(RECONNECT_MIN_MS)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const closedByUsRef = useRef(false)
  const onControlRef = useRef(onControl)
  const onTimerSyncRef = useRef(onTimerSync)
  const onSebAuthFailedRef = useRef(onSebAuthFailed)

  useLayoutEffect(() => {
    onControlRef.current = onControl
    onTimerSyncRef.current = onTimerSync
    onSebAuthFailedRef.current = onSebAuthFailed
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    closedByUsRef.current = false

    // Browsers cannot set custom headers on a WebSocket handshake, so the
    // Config Key token travels as the connection's first message instead of
    // (as it used to) the URL's query string — where reverse proxies and
    // access logs would record it. The server answers seb_auth_ok once the
    // handshake verified and the session is registered with the room.
    // Keys resolve from one memoized updateKeys handshake, so awaiting them
    // together costs nothing extra.
    async function connect() {
      const [sebKey, bekKey] = sebRequired
        ? await Promise.all([getSebKey(), getSebRequestHash()])
        : [null, null]
      if (cancelled) return

      const base = wsBaseUrl() || window.location.origin.replace(/^http/, "ws")
      const url = new URL(`${base}/ws/exam/${sessionId}`)
      const ws = new WebSocket(url)
      wsRef.current = ws

      const startPings = () => {
        pingTimerRef.current = setInterval(() => {
          try {
            ws.send(JSON.stringify({ type: "ping" }))
          } catch {
            // Socket will surface the failure via onclose/onerror.
          }
        }, PING_INTERVAL_MS)
      }

      ws.onopen = () => {
        reconnectDelayRef.current = RECONNECT_MIN_MS
        if (!sebRequired) {
          setConnected(true)
          startPings()
          return
        }
        // First message authenticates; pings wait until seb_auth_ok so an
        // early ping can never be read as (and reject) the auth handshake.
        try {
          ws.send(JSON.stringify({ type: "seb_auth", sebKey, bekKey }))
        } catch {
          ws.close()
        }
      }

      ws.onmessage = (event) => {
        let env: Envelope
        try {
          env = JSON.parse(event.data)
        } catch {
          return
        }
        switch (env.type) {
          case "seb_auth_ok":
            setConnected(true)
            startPings()
            break
          case "seb_auth_failed":
            // The server verified the token against the exam's config and
            // refused: retrying will not change that verdict, so stop the
            // reconnect loop and surface it once.
            closedByUsRef.current = true
            onSebAuthFailedRef.current?.()
            ws.close()
            break
          case "answer:ack":
            if (env.id) resolveAck(env.id, true)
            break
          case "answer:error":
            if (env.id) resolveAck(env.id, false)
            break
          case "exam:control":
            onControlRef.current(env.data as ControlData)
            break
          case "timer:sync":
            onTimerSyncRef.current(env.data as TimerSyncData)
            break
          default:
            break
        }
      }

      ws.onclose = () => {
        setConnected(false)
        if (pingTimerRef.current) clearInterval(pingTimerRef.current)
        for (const [, waiter] of ackWaiters.current) {
          clearTimeout(waiter.timeout)
          waiter.resolve(false)
        }
        ackWaiters.current.clear()
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

    function resolveAck(id: string, ok: boolean) {
      const waiter = ackWaiters.current.get(id)
      if (!waiter) return
      clearTimeout(waiter.timeout)
      ackWaiters.current.delete(id)
      waiter.resolve(ok)
    }

    // Routed through the reconnect timer so the effect's cleanup cancels a
    // still-pending first connect the same way it cancels a retry.
    reconnectTimerRef.current = setTimeout(
      () => void connect(),
      Math.random() * INITIAL_CONNECT_JITTER_MS
    )

    return () => {
      cancelled = true
      closedByUsRef.current = true
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (pingTimerRef.current) clearInterval(pingTimerRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [sessionId, enabled, sebRequired])

  const sendAnswer = useCallback(
    (
      questionId: string,
      content: AnswerContent,
      clientSeq: number
    ): Promise<boolean> => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false)

      const id = crypto.randomUUID()
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          ackWaiters.current.delete(id)
          resolve(false)
        }, ACK_TIMEOUT_MS)
        ackWaiters.current.set(id, { resolve, timeout })
        try {
          ws.send(
            JSON.stringify({
              type: "answer:save",
              id,
              data: { questionId, content, clientSeq },
            })
          )
        } catch {
          clearTimeout(timeout)
          ackWaiters.current.delete(id)
          resolve(false)
        }
      })
    },
    []
  )

  // Fire-and-forget: no ack, silently dropped if the socket isn't open —
  // these are best-effort telemetry, not something worth retrying/queuing.
  // `kind` is the IntegrityEventKind enum (typed at the boundary so a typo'd
  // kind can't compile); the Go side re-validates it at runtime.
  const sendIntegrityEvent = useCallback(
    (kind: IntegrityEventKind, detail?: string) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(
          JSON.stringify({
            type: "integrity:event",
            data: { kind, detail, clientTime: new Date().toISOString() },
          })
        )
      } catch {
        // Best-effort; nothing to recover here.
      }
    },
    []
  )

  // Memoized so consumers can safely list the hook's result in dependency
  // arrays — a fresh object per render would retrigger their effects.
  return useMemo(
    () => ({ connected, sendAnswer, sendIntegrityEvent }),
    [connected, sendAnswer, sendIntegrityEvent]
  )
}
