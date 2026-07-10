// First-party browser terminal: our OWN xterm.js talking to ttyd over its documented WebSocket
// protocol, IN PLACE of embedding ttyd's bundled page in an <iframe>. Owning the frontend is the whole
// point — it's the only way to give copy/paste, a right-click menu, clickable links, search and console
// theming, none of which we can reach inside ttyd's iframe. The backend is unchanged: ttyd is still the
// PTY/tmux bridge (attach.sh resurrection, the auth proxy, the gate hook all stay); we just replace its
// HTML with this.
//
// ttyd's wire protocol (v1.7.x), reimplemented here:
//   • connect to  <base>/ws<search>  with subprotocol 'tty'  (search carries ?arg=aos-<id>)
//   • first frame: JSON { AuthToken, columns, rows }  (no command prefix; token is '' — no basic auth)
//   • client→server: a 1-char command prefix then data —  '0' INPUT · '1' RESIZE {columns,rows} ·
//     '2' PAUSE · '3' RESUME
//   • server→client: first byte is the command —  '0' OUTPUT (raw bytes) · '1' SET_WINDOW_TITLE ·
//     '2' SET_PREFERENCES
import { useEffect, useRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { CanvasAddon } from '@xterm/addon-canvas'
import '@xterm/xterm/css/xterm.css'

// ttyd command bytes.
const C_INPUT = '0'
const C_RESIZE = '1'
const C_PAUSE = '2'
const C_RESUME = '3'
const S_OUTPUT = 48 // '0'
const S_TITLE = 49 // '1'
const S_PREFS = 50 // '2'

const enc = new TextEncoder()

/** Write text to the clipboard in BOTH secure and insecure contexts. `navigator.clipboard` only exists
 *  on https/localhost — but the console is often served over plain http on a tailnet host, where it's
 *  undefined. Fall back to a hidden-textarea `execCommand('copy')` (the same trick ttyd used), which
 *  works in insecure contexts as long as we're inside a user gesture (mouse-up / key-down). */
function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
      document.body.appendChild(ta)
      ta.focus(); ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      ok ? resolve() : reject(new Error('execCommand copy failed'))
    } catch (e) { reject(e) }
  })
}

/** Console-matched dark theme (neutral-950 bg, geist-ish selection). */
export const AOS_THEME: ITheme = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3b82f680', // blue-500 @ 50%
  selectionForeground: undefined,
  black: '#171717', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
  blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e5e5',
  brightBlack: '#525252', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde047',
  brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa',
}

export interface XtermHandle {
  term: Terminal
  fit: () => void
  search: SearchAddon
  copySelection: () => void
  paste: () => void
}

export function Xterm({
  wsUrl,
  fontSize = 14,
  theme = AOS_THEME,
  copyOnSelect = false,
  onTitle,
  onStatus,
  onReady,
  onCopy,
}: {
  /** Absolute or relative ws(s):// URL, incl. the ?arg=… query. If it starts with '/', it's resolved
   *  against the current origin (http→ws, https→wss). */
  wsUrl: string
  fontSize?: number
  theme?: ITheme
  /** Copy the selection to the clipboard the moment a drag-selection finishes (highlight is kept). */
  copyOnSelect?: boolean
  onTitle?: (title: string) => void
  onStatus?: (s: 'connecting' | 'open' | 'closed') => void
  onReady?: (h: XtermHandle) => void
  /** Fired after text is successfully written to the clipboard (for a "copied" flash). */
  onCopy?: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  // Latest-callback refs so the socket effect doesn't re-run (and re-attach) when a parent re-renders.
  const cbs = useRef({ onTitle, onStatus, onReady, onCopy })
  cbs.current = { onTitle, onStatus, onReady, onCopy }
  const opts = useRef({ copyOnSelect })
  opts.current = { copyOnSelect }

  // Font size is a live option — apply without tearing the terminal down.
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  useEffect(() => {
    if (termRef.current) { termRef.current.options.fontSize = fontSize; fitRef.current?.fit() }
  }, [fontSize])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme,
      cursorBlink: true,
      scrollback: 10000,
      // Copy/paste ergonomics — the reason we own the frontend:
      // hold Option (mac) / any drag with this on lets you select even while claude's mouse-reporting is
      // active; right-click pastes the OS clipboard.
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon())
    term.open(host)
    // Canvas renderer: draw the grid to a <canvas> instead of the default DOM renderer, whose real
    // per-cell text is natively selectable by the browser — that native selection competes with xterm's
    // own selection overlay and "wobbles" (a second, differently-coloured highlight). Canvas has no
    // selectable DOM, so only xterm's selection shows. Falls back to DOM if canvas 2d is unavailable.
    try { term.loadAddon(new CanvasAddon()) } catch { /* no 2d context — DOM renderer stays */ }
    termRef.current = term
    fitRef.current = fit
    try { fit.fit() } catch { /* not laid out yet */ }

    // ── clipboard ────────────────────────────────────────────────────────────────────────────────
    // We're in the app's own document (no iframe), so navigator.clipboard just works.
    const copySelection = () => {
      const sel = term.getSelection()
      if (sel) writeClipboard(sel).then(() => cbs.current.onCopy?.(), () => {})
    }
    const paste = async () => {
      try { const t = await navigator.clipboard?.readText(); if (t) send(C_INPUT + t) } catch { /* denied */ }
    }
    // OSC 52 — claude's own copy-on-select emits this (tmux set-clipboard on forwards it). ttyd's page
    // drops it; we honour it, so highlighting inside the TUI lands on the OS clipboard with no modifier.
    term.parser.registerOscHandler(52, (data) => {
      const b64 = data.split(';')[1] ?? ''
      try { writeClipboard(atob(b64)).then(() => cbs.current.onCopy?.(), () => {}) } catch { /* bad payload */ }
      return true
    })
    // Cmd/Ctrl+C copies the selection (and ONLY when there is one — otherwise ^C passes through as
    // SIGINT). Esc clears a lingering selection instead of reaching the app (a common "cancel" gesture;
    // when there's no xterm selection it falls through, so a tmux copy-mode selection still cancels via
    // tmux). Paste is left to xterm's OWN native handler (the browser paste event) — intercepting it here
    // would double-paste. Returning false tells xterm not to also forward the key to the pty.
    term.attachCustomKeyEventHandler((e) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key === 'c' && term.hasSelection()) { if (e.type === 'keydown') copySelection(); return false }
      if (e.key === 'Escape' && term.hasSelection()) { if (e.type === 'keydown') term.clearSelection(); return false }
      return true
    })

    // ── socket ───────────────────────────────────────────────────────────────────────────────────
    const url = wsUrl.startsWith('/')
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${wsUrl}`
      : wsUrl
    cbs.current.onStatus?.('connecting')
    const ws = new WebSocket(url, ['tty'])
    ws.binaryType = 'arraybuffer'
    let dataDisp: { dispose(): void } | null = null
    let resizeDisp: { dispose(): void } | null = null
    let titleDisp: { dispose(): void } | null = null

    const send = (s: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(enc.encode(s)) }
    // Basic flow control: pause the server while xterm's write buffer is draining, resume after.
    let pending = 0
    const HIGH = 512 * 1024

    ws.onopen = () => {
      ws.send(enc.encode(JSON.stringify({ AuthToken: '', columns: term.cols, rows: term.rows })))
      cbs.current.onStatus?.('open')
      dataDisp = term.onData((d) => send(C_INPUT + d))
      resizeDisp = term.onResize(({ cols, rows }) => send(C_RESIZE + JSON.stringify({ columns: cols, rows })))
      titleDisp = term.onTitleChange((t) => cbs.current.onTitle?.(t))
      // Nudge a resize so ttyd sizes the pty to our actual layout.
      try { fit.fit() } catch { /* ignore */ }
      cbs.current.onReady?.({ term, fit: () => { try { fit.fit() } catch { /* ignore */ } }, search, copySelection, paste })
    }
    ws.onmessage = (ev) => {
      const buf = ev.data as ArrayBuffer
      if (typeof buf === 'string') return
      const view = new Uint8Array(buf)
      const cmd = view[0]
      const body = view.subarray(1)
      if (cmd === S_OUTPUT) {
        pending += body.length
        if (pending > HIGH) send(C_PAUSE)
        term.write(body, () => { pending -= body.length; if (pending <= HIGH) send(C_RESUME) })
      } else if (cmd === S_TITLE) {
        cbs.current.onTitle?.(new TextDecoder().decode(body))
      } else if (cmd === S_PREFS) {
        /* ttyd server prefs — we set our own, ignore */
      }
    }
    ws.onclose = () => cbs.current.onStatus?.('closed')
    ws.onerror = () => cbs.current.onStatus?.('closed')

    // Select-to-copy: on mouse-up, if a drag left a selection, copy it (highlight is kept — we never
    // clear it, unlike tmux copy-mode). Guarded by the copyOnSelect prop via a ref so toggling it
    // doesn't rebuild the socket. Deferred a tick: xterm finalizes the selection on its OWN
    // document-level mouseup, which fires AFTER this host-level (bubble) one — so we'd otherwise read a
    // stale/empty selection. The microtask lets xterm settle first.
    const onMouseUp = () => {
      if (!opts.current.copyOnSelect) return
      setTimeout(() => { if (term.hasSelection()) copySelection() }, 0)
    }
    host.addEventListener('mouseup', onMouseUp)

    // Reflow on container resize.
    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    ro.observe(host)

    return () => {
      host.removeEventListener('mouseup', onMouseUp)
      ro.disconnect()
      dataDisp?.dispose(); resizeDisp?.dispose(); titleDisp?.dispose()
      try { ws.close() } catch { /* ignore */ }
      term.dispose()
      termRef.current = null; fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]) // theme/fontSize handled live above; only a new socket URL rebuilds.

  return <div ref={hostRef} className="min-h-0 w-full flex-1" style={{ background: theme.background }} />
}
