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
//
// Natural selection + links over a mouse-reporting TUI. claude's TUI (fullscreen, alt-screen) turns on
// mouse tracking. The moment xterm sees a tracking mode it DISABLES its own selection service and starts
// forwarding click/drag to the app — so a plain drag no longer selects (you'd need Option held) and a
// link click gets eaten. But claude only actually uses the WHEEL (it runs with DISABLE_MOUSE_CLICKS);
// it ignores the click/drag reports entirely. So we intercept the PTY output stream and strip just the
// mouse-*tracking* DECSET modes (1000/1001/1002/1003) before xterm sees them: xterm stays in its normal,
// no-mouse state (plain drag selects, links are clickable like a web page), and we forward ONLY the
// wheel back to claude ourselves (as SGR mouse events) so its conversation still scrolls. claude's own
// mouse state is unchanged — it enabled tracking on its side and happily parses the wheel events we send;
// it just never gets clicks, which it discards anyway. Uses only documented xterm API (no internals), so
// it survives xterm upgrades. See `stripMouseTracking` + the custom wheel handler below.
import { useEffect, useRef } from 'react'
import { Terminal, type ITheme, type ILink, type ILinkProvider } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
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

// ── mouse-tracking stripper ──────────────────────────────────────────────────────────────────────────
// The DECSET private modes that make xterm switch into "forward the mouse to the app" (and thus disable
// selection). We drop these from the output stream; every other private mode — SGR encoding (1006),
// focus (1004), alt-screen (1049), bracketed paste (2004), … — passes through untouched.
const TRACK_MODES = new Set([1000, 1001, 1002, 1003])
const ESC = 0x1b, LBRACK = 0x5b, QUEST = 0x3f, SET = 0x68 /* h */, RESET = 0x6c /* l */

/** A stateful filter over the raw PTY byte stream that removes mouse-tracking DECSET/DECRST sequences
 *  (`ESC [ ? …h|l`) while preserving all other output verbatim, and reports (via `onWant`) whether the
 *  app currently wants the mouse — so the wheel handler knows to forward. Handles a sequence split across
 *  WebSocket frames by carrying an unfinished tail to the next call. */
function stripMouseTracking(onWant: (want: boolean) => void): (input: Uint8Array) => Uint8Array {
  let carry = new Uint8Array(0)
  return (input: Uint8Array): Uint8Array => {
    let buf = input
    if (carry.length) { const j = new Uint8Array(carry.length + input.length); j.set(carry); j.set(input, carry.length); buf = j; carry = new Uint8Array(0) }
    const n = buf.length
    const out = new Uint8Array(n)
    let o = 0, i = 0
    while (i < n) {
      const b = buf[i]
      if (b !== ESC) { out[o++] = b; i++; continue }
      // Need ESC '[' '?' to be a private mode set/reset; if the buffer ends mid-prefix, hold it.
      if (i + 2 >= n) { if (buf[i + 1] === LBRACK || i + 1 >= n) { carry = buf.slice(i); break } out[o++] = b; i++; continue }
      if (buf[i + 1] !== LBRACK || buf[i + 2] !== QUEST) { out[o++] = b; i++; continue }
      // Scan numeric params (digits + ';') then a final byte.
      let j = i + 3
      let params = ''
      while (j < n) { const c = buf[j]; if ((c >= 0x30 && c <= 0x39) || c === 0x3b) { params += String.fromCharCode(c); j++ } else break }
      if (j >= n) { carry = buf.slice(i); break } // incomplete — wait for the rest
      const fin = buf[j]
      if (fin !== SET && fin !== RESET) { for (let k = i; k <= j; k++) out[o++] = buf[k]; i = j + 1; continue } // e.g. ?…$p — pass through
      const modes = params.split(';').filter((s) => s.length)
      const kept = modes.filter((m) => !TRACK_MODES.has(Number(m)))
      if (modes.some((m) => TRACK_MODES.has(Number(m)))) onWant(fin === SET)
      if (kept.length) { out[o++] = ESC; out[o++] = LBRACK; out[o++] = QUEST; const s = kept.join(';'); for (let k = 0; k < s.length; k++) out[o++] = s.charCodeAt(k); out[o++] = fin }
      i = j + 1
    }
    if (carry.length > 64) { for (let k = 0; k < carry.length; k++) out[o++] = carry[k]; carry = new Uint8Array(0) } // runaway guard
    return o === n ? out : out.subarray(0, o)
  }
}

// ── link detection ───────────────────────────────────────────────────────────────────────────────────
// Matchers run in priority order; earlier matches win over later ones on the same columns, so a full URL
// isn't also picked up as a bare domain. The TLD list is deliberately conservative so `file.ts:42` or
// `Component.tsx`, `src/main.rs` and version strings don't get underlined as if they were `example.com`.
// The disambiguation rule mirrors how a human reads it: a **bare** `host.tld` needs a KNOWN TLD (so
// `file.ts`/`main.rs` are excluded), but a host that carries a **/path** is almost certainly a URL, so we
// accept any TLD there (`foo.bar/baz`, `docs.github.io/xterm`). The broad TLD list covers the common
// gTLDs + ccTLDs; add to it rather than loosening the bare-domain rule (that's what guards false hits).
const TLD = 'com|net|org|io|ai|dev|app|sh|co|gg|xyz|me|so|to|tv|cloud|tech|edu|gov|info|biz|us|uk|ca|de|fr'
  + '|jp|in|store|shop|site|online|live|ly|im|be|nl|eu|au|nz|ru|cn|br|es|it|se|no|fi|pl|ch|at|dk|ie|pro'
  + '|page|blog|wiki|news|design|studio|agency|digital|link|click|network|systems|solutions|group|world'
  + '|life|today|media|email|chat|zone|run|build|host|space|fun|art|tools|cc|tw|kr|za|mx|ar|id|ua|sg|hk'
const TAIL = `[^\\s"'\`<>)\\]}]` // a link body char — stops at whitespace and common wrappers
const HOST = `[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)+` // a multi-label host: at least one dot
const MATCHERS: { re: RegExp; url: (m: string) => string }[] = [
  // 1. explicit scheme — take the whole thing verbatim.
  { re: new RegExp(`(?:https?|ftp|file)://${TAIL}+`, 'gi'), url: (m) => m },
  // 2. www.… — no scheme, assume https.
  { re: new RegExp(`\\bwww\\.${TAIL}+`, 'gi'), url: (m) => `https://${m}` },
  // 3. localhost / IPv4, with optional :port and /path — local dev servers, assume http.
  { re: new RegExp(`\\b(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d+)?(?:/${TAIL}*)?`, 'gi'), url: (m) => `http://${m}` },
  // 4. any multi-label host that carries a /path (the slash makes it a URL regardless of TLD).
  { re: new RegExp(`\\b${HOST}(?::\\d+)?/${TAIL}*`, 'gi'), url: (m) => `https://${m}` },
  // 5. a BARE host (no path) — one or more labels ending in a known TLD, and the TLD must not run into a
  //    longer label (`v1.2.io-beta` is not `…io`). Optional :port for e.g. a bare `host.tld:8080`.
  { re: new RegExp(`\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9-]+)*\\.(?:${TLD})(?![a-z0-9-])(?::\\d+)?`, 'gi'), url: (m) => `https://${m}` },
]

function openUrl(url: string) { try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* popup blocked */ } }

/** Trim trailing sentence punctuation that a link body regex greedily swallowed (`…example.com.` → drop
 *  the period), returning how many chars were shaved so the highlight range can shrink to match. */
function trimTrail(s: string): { text: string; shaved: number } {
  const m = s.match(/[.,;:!?)\]}'"]+$/)
  const shaved = m ? m[0].length : 0
  return { text: shaved ? s.slice(0, -shaved) : s, shaved }
}

/** A link provider spanning the four matchers above over a single buffer row. xterm asks per row; we read
 *  that row's text, find every non-overlapping match, and hand back clickable ranges (1-based, inclusive)
 *  that open in a new tab. Wrapped links that span rows are matched on whichever row they start — good
 *  enough for the URLs claude prints; keeps this simple and allocation-light. */
function makeLinkProvider(term: Terminal): ILinkProvider {
  return {
    provideLinks(row, cb) {
      try {
        const line = term.buffer.active.getLine(row - 1)
        if (!line) return cb(undefined)
        const text = line.translateToString(true)
        if (!text || !/[.:/]/.test(text)) return cb(undefined)
        const taken: boolean[] = []
        const links: ILink[] = []
        for (const { re, url } of MATCHERS) {
          re.lastIndex = 0
          let m: RegExpExecArray | null
          while ((m = re.exec(text))) {
            const start = m.index
            const { text: raw } = trimTrail(m[0])
            const end = start + raw.length // exclusive
            if (raw.length < 4 || taken[start] || taken[end - 1]) continue
            for (let k = start; k < end; k++) taken[k] = true
            const target = url(raw)
            links.push({
              text: raw,
              range: { start: { x: start + 1, y: row }, end: { x: end, y: row } },
              decorations: { pointerCursor: true, underline: true },
              activate: (e) => { e.preventDefault(); openUrl(target) },
            })
          }
        }
        cb(links.length ? links : undefined)
      } catch { cb(undefined) } // never let a bad row break the linkifier
    },
  }
}

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
      // Selection ergonomics — the reason we own the frontend. We strip the app's mouse-tracking modes
      // (see `stripMouseTracking`), so a plain drag already selects with no modifier; Option-drag stays a
      // harmless fallback in case some future app enables a mode we don't strip.
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      allowProposedApi: true,
      // OSC 8 hyperlinks (ESC ] 8 ; ; <uri>) — claude and modern CLIs emit these; open them in a new tab.
      linkHandler: { activate: (_e, uri) => openUrl(uri), allowNonHttpProtocols: false },
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(host)
    // Canvas renderer: draw the grid to a <canvas> instead of the default DOM renderer, whose real
    // per-cell text is natively selectable by the browser — that native selection competes with xterm's
    // own selection overlay and "wobbles" (a second, differently-coloured highlight). Canvas has no
    // selectable DOM, so only xterm's selection shows. Falls back to DOM if canvas 2d is unavailable.
    try { term.loadAddon(new CanvasAddon()) } catch { /* no 2d context — DOM renderer stays */ }
    // Clickable links for bare domains / localhost:port / www / paths / full URLs (our own provider — the
    // stock WebLinksAddon only matches full `https://…`, missing exactly the "rendered link without a
    // scheme"). Registered AFTER open()/the renderer so the linkifier is fully wired first.
    term.registerLinkProvider(makeLinkProvider(term))
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

    // ── mouse forwarding ───────────────────────────────────────────────────────────────────────────
    // We strip the app's mouse-tracking from the output stream (below), so xterm no longer forwards the
    // wheel to the app on its own. Re-supply just the wheel: while the app WANTS the mouse (it emitted a
    // tracking DECSET — claude's TUI, or tmux at a bare prompt), translate each wheel notch into SGR
    // wheel-button events (button 64 up / 65 down) and send them down, so claude scrolls its conversation
    // and tmux scrolls its scrollback exactly as if we'd never stripped the mode. When no app wants the
    // mouse, return true to let xterm do its own local scrollback scroll.
    let appMouseWanted = false
    term.attachCustomWheelEventHandler((e) => {
      if (!appMouseWanted || e.deltaY === 0) return true
      const rect = host.getBoundingClientRect()
      const col = Math.min(term.cols, Math.max(1, Math.floor(((e.clientX - rect.left) / rect.width) * term.cols) + 1))
      const rowY = Math.min(term.rows, Math.max(1, Math.floor(((e.clientY - rect.top) / rect.height) * term.rows) + 1))
      const btn = e.deltaY < 0 ? 64 : 65
      const notches = e.deltaMode === 1 ? Math.abs(e.deltaY) // lines
        : e.deltaMode === 2 ? Math.abs(e.deltaY) * term.rows // pages
        : Math.max(1, Math.round(Math.abs(e.deltaY) / 40)) // pixels
      let seq = ''
      for (let k = 0; k < Math.min(notches, 8); k++) seq += `\x1b[<${btn};${col};${rowY}M`
      send(C_INPUT + seq)
      return false // handled — don't let xterm also scroll its (empty, on the alt-screen) local buffer
    })
    const mouseFilter = stripMouseTracking((w) => { appMouseWanted = w })

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
        // Strip the app's mouse-tracking DECSET modes before xterm sees them (keeps native drag-select +
        // clickable links) — see stripMouseTracking. Flow-control accounts for the cleaned length.
        const clean = mouseFilter(body)
        pending += clean.length
        if (pending > HIGH) send(C_PAUSE)
        term.write(clean, () => { pending -= clean.length; if (pending <= HIGH) send(C_RESUME) })
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
