#!/usr/bin/env node
// Terminal test bed runner. One command to iterate on the first-party <Xterm> client in isolation —
// against a THROWAWAY tmux+ttyd running plain `bash`, with no agent-os server, no claude, no auth.
//
//   node scripts/termbed.mjs        # → open the printed http://localhost:5199/termbed.html
//
// It starts:
//   1. a throwaway tmux session (same clipboard/passthrough tuning as prod: set-clipboard on, so
//      OSC 52 copy-on-select flows through exactly as it will under claude)
//   2. ttyd bound to it on :7699, base /pty  (the PTY bridge — the same daemon prod uses)
//   3. vite dev on :5199, which serves termbed.html and proxies /pty → ttyd (see web/vite.config.ts)
// so editing web/src/Xterm.tsx hot-reloads. Ctrl-C tears all three down.
//
// Requires the same native tools as prod: `tmux` and `ttyd` on PATH (brew install tmux ttyd).
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TTYD_PORT = 7699
const VITE_PORT = 5199
const SOCK = join(tmpdir(), `aos-termbed-${process.pid}.sock`)
const SESSION = 'termbed'
const webDir = new URL('../web/', import.meta.url).pathname

function have(bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0
}
for (const bin of ['tmux', 'ttyd']) {
  if (!have(bin)) { console.error(`✗ '${bin}' not found on PATH — brew install tmux ttyd`); process.exit(1) }
}

// 1. Throwaway tmux session running a plain login shell, tuned like the prod sessions.
// `-f /dev/null`: ignore the user's ~/.tmux.conf so the test bed exercises OUR xterm client, not the
// host's tmux config. (A `set -g mouse on` there would hand wheel + drag to tmux copy-mode — tmux would
// scroll its own history and copy-on-select, clearing the highlight — masking the real client behaviour.)
const shell = process.env.SHELL || '/bin/bash'
// TERMBED_CMD lets you point the session at a mouse-reporting TUI instead of a bare shell — e.g.
// `TERMBED_CMD='node ../scripts/mouse-tui.mjs' node scripts/termbed.mjs` to reproduce claude's mouse
// mode and verify native drag-select + clickable links + wheel forwarding. Default: a login shell.
const prog = process.env.TERMBED_CMD ? ['sh', '-c', process.env.TERMBED_CMD] : [shell]
spawnSync('tmux', ['-f', '/dev/null', '-S', SOCK, 'new-session', '-d', '-s', SESSION, ...prog], { stdio: 'ignore' })
for (const opt of [
  ['set', '-g', 'set-clipboard', 'on'],       // forward OSC 52 copy-on-select → our client's OSC 52 handler
  ['set', '-g', 'allow-passthrough', 'on'],
  ['set', '-s', 'extended-keys', 'on'],
  ['set', '-as', 'terminal-features', 'xterm*:extkeys:hyperlinks'],
  // Mouse on so the WHEEL scrolls tmux's scrollback even at a bare shell prompt (xterm can't reach it
  // otherwise — everything lives on tmux's alternate screen). A running TUI (claude) that requests its
  // own mouse mode still gets the wheel forwarded to it.
  ['set', '-g', 'mouse', 'on'],
  ['set', '-g', 'mode-style', 'bg=#2563eb,fg=#ffffff'], // blue selection, like xterm's
  // Drag-copy keeps the highlight (…-no-clear) instead of copying-and-cancelling — that clear-on-copy
  // was the "selection vanishes" you saw from the host's ~/.tmux.conf. Copy still fires OSC 52 → clipboard.
  ['bind', '-T', 'copy-mode', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear'],
  ['bind', '-T', 'copy-mode-vi', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear'],
]) spawnSync('tmux', ['-S', SOCK, ...opt], { stdio: 'ignore' })

// 2. ttyd → tmux (attach-or-create so a reconnect re-attaches to the same shell).
const ttyd = spawn('ttyd', [
  '-p', String(TTYD_PORT), '-i', '127.0.0.1', '-b', '/pty', '-W',
  '-t', 'disableLeaveAlert=true',
  'tmux', '-f', '/dev/null', '-u', '-S', SOCK, 'new-session', '-A', '-s', SESSION, ...prog,
], { stdio: 'inherit' })
ttyd.on('error', (e) => { console.error('✗ ttyd failed:', e.message); cleanup(1) })

// 3. vite dev — serves termbed.html + proxies /pty to ttyd. Hot-reloads Xterm.tsx.
const vite = spawn('npm', ['run', 'dev', '--', '--port', String(VITE_PORT), '--strictPort'], {
  cwd: webDir, stdio: 'inherit', env: { ...process.env },
})
vite.on('error', (e) => { console.error('✗ vite failed:', e.message); cleanup(1) })

setTimeout(() => {
  console.log(`\n  ▸ Terminal test bed:  http://localhost:${VITE_PORT}/termbed.html`)
  console.log('    (throwaway tmux+ttyd on a plain shell — Ctrl-C to tear it all down)\n')
}, 1500)

let done = false
function cleanup(code = 0) {
  if (done) return
  done = true
  try { ttyd.kill() } catch { /* */ }
  try { vite.kill() } catch { /* */ }
  spawnSync('tmux', ['-S', SOCK, 'kill-server'], { stdio: 'ignore' })
  process.exit(code)
}
process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))
