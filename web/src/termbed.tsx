// Standalone test bed for the first-party <Xterm> terminal. Mounts the REAL, shippable component
// against a throwaway tmux+ttyd running plain `bash` (see scripts/termbed.mjs) — no agent-os server, no
// claude, no auth in the loop — so we can hammer copy/paste, selection, scroll, search and theming in
// isolation before swapping it into the live console's TerminalFrame.
import { StrictMode, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { Xterm, type XtermHandle } from './Xterm'

function TermBed() {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [title, setTitle] = useState('')
  const [font, setFont] = useState(14)
  const [find, setFind] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [copied, setCopied] = useState(false)
  const h = useRef<XtermHandle | null>(null)
  const onReady = useCallback((handle: XtermHandle) => {
    h.current = handle
    // Test hook: expose the live Terminal so the Playwright harness can assert selection/buffer state
    // (the canvas renderer draws no readable DOM). Test bed only — never mounted in the real console.
    ;(window as unknown as { __aosTerm?: unknown }).__aosTerm = handle.term
  }, [])
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onCopy = useCallback(() => {
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 900)
  }, [])

  const dot = status === 'open' ? 'bg-green-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-red-500'

  return (
    // select-none on the whole pane so a selection drag that strays out of the terminal canvas (e.g. up
    // into this header) doesn't start a native browser text-selection of the chrome — which would wobble
    // against xterm's own selection just like the DOM-renderer bug did. Inputs re-enable select-text.
    <div className="flex h-screen select-none flex-col bg-neutral-950 text-neutral-200" onClick={() => setMenu(null)}>
      <div className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-3 py-2 text-xs">
        <span className="font-semibold">Terminal test bed</span>
        <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${dot}`} />{status}</span>
        {title && <span className="text-neutral-500">· {title}</span>}
        <div className="ml-auto flex items-center gap-2">
          <input
            value={find}
            onChange={(e) => { setFind(e.target.value); h.current?.search.findNext(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') h.current?.search.findNext(find) }}
            placeholder="search…"
            className="w-32 select-text rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 outline-none focus:border-neutral-500"
          />
          <button className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800" onClick={() => setFont((f) => Math.max(8, f - 1))}>A−</button>
          <span className="tabular-nums text-neutral-500">{font}px</span>
          <button className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800" onClick={() => setFont((f) => Math.min(40, f + 1))}>A+</button>
          <button className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800" onClick={() => h.current?.copySelection()}>✂ Copy</button>
          <button className="rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800" onClick={() => h.current?.paste()}>⎘ Paste</button>
        </div>
      </div>

      <div
        className="relative flex min-h-0 flex-1 flex-col p-2"
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
      >
        <Xterm wsUrl="/pty/ws" fontSize={font} copyOnSelect onStatus={setStatus} onTitle={setTitle} onReady={onReady} onCopy={onCopy} />
        {copied && (
          <div className="pointer-events-none absolute right-4 top-4 z-20 rounded-md bg-green-600/90 px-2.5 py-1 text-xs font-medium text-white shadow-lg">
            ✓ copied
          </div>
        )}
        {menu && (
          <div
            className="fixed z-10 min-w-32 rounded-md border border-neutral-700 bg-neutral-900 py-1 text-xs shadow-xl"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="block w-full px-3 py-1 text-left hover:bg-neutral-800" onClick={() => { h.current?.copySelection(); setMenu(null) }}>Copy</button>
            <button className="block w-full px-3 py-1 text-left hover:bg-neutral-800" onClick={() => { void h.current?.paste(); setMenu(null) }}>Paste</button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-500">
        Try: drag to select → Cmd/Ctrl+C · right-click → Copy/Paste · run <code className="text-neutral-400">printf '\\e]52;c;%s\\a' "$(printf hi | base64)"</code> to test OSC 52 · resize the window.
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><TermBed /></StrictMode>)
