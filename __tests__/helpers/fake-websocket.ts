/**
 * Minimal in-memory WebSocket for hook tests. Install with
 * `vi.stubGlobal("WebSocket", FakeWebSocket)`; each constructed socket is
 * recorded in `FakeWebSocket.instances` and driven from the test with
 * open()/receive()/error()/close().
 */
export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  static reset() {
    FakeWebSocket.instances = []
  }

  static get last(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1)
    if (!ws) throw new Error("no FakeWebSocket was constructed")
    return ws
  }

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  throwOnSend = false

  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  /** Parsed JSON of every frame sent so far. */
  get sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s))
  }

  send(data: string) {
    if (this.throwOnSend) throw new Error("send failed")
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("InvalidStateError: socket not open")
    }
    this.sent.push(data)
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new Event("close") as CloseEvent)
  }

  // --- test drivers ---

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event("open"))
  }

  receive(message: unknown) {
    this.receiveRaw(JSON.stringify(message))
  }

  receiveRaw(data: string) {
    this.onmessage?.(new MessageEvent("message", { data }))
  }

  error() {
    this.onerror?.(new Event("error"))
  }
}
