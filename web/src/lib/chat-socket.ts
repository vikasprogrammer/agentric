// The Messages push channel, shared by everything in the console that cares (the Messages page, and the
// app-wide notifier). ONE WebSocket to `/api/chat/ws`, opened on the first subscriber and closed with
// the last; it reconnects with backoff and re-sends what it was watching. See src/edge/chat-socket.ts.
export interface ChatPush { t: 'hello' | 'list' | 'thread'; key?: string; data?: unknown; error?: string }
type Listener = (m: ChatPush) => void
type StatusListener = (connected: boolean) => void

const listeners = new Set<Listener>()
const statusListeners = new Set<StatusListener>()
let ws: WebSocket | null = null
let connected = false
let retry = 0
let timer: ReturnType<typeof setTimeout> | undefined
/** What the Messages page is looking at — re-sent on every (re)connect. */
let watching: { watch: string; thread: number } = { watch: '', thread: 0 }

const setConnected = (v: boolean) => { if (v !== connected) { connected = v; statusListeners.forEach((f) => f(v)) } }
const tell = () => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...watching, visible: document.visibilityState === 'visible' })) }

function open() {
  if (ws || listeners.size === 0) return
  let s: WebSocket
  try { s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/chat/ws`) } catch { return }
  ws = s
  s.onopen = () => { retry = 0; setConnected(true); tell() }
  s.onmessage = (e) => {
    let m: ChatPush
    try { m = JSON.parse(String(e.data)) } catch { return }
    listeners.forEach((f) => f(m))
  }
  s.onclose = () => {
    if (ws === s) ws = null
    setConnected(false)
    if (listeners.size > 0) timer = setTimeout(open, Math.min(30_000, 1500 * 2 ** retry++))
  }
  s.onerror = () => { try { s.close() } catch { /* already closing */ } }
}

document.addEventListener('visibilitychange', tell)

export const chatSocket = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    open()
    return () => {
      listeners.delete(fn)
      if (listeners.size === 0) { if (timer) clearTimeout(timer); try { ws?.close() } catch { /* gone */ } ws = null; setConnected(false) }
    }
  },
  onStatus(fn: StatusListener): () => void { statusListeners.add(fn); fn(connected); return () => { statusListeners.delete(fn) } },
  /** Which conversation (and thread panel) the page has open; '' = none. */
  watch(key: string, thread = 0) { watching = { watch: key, thread }; tell() },
  /** "I'm typing" in the watched room. */
  typing() { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ typing: true })) },
  isConnected: () => connected,
}
