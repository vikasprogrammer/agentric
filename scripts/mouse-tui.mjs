#!/usr/bin/env node
// A tiny fullscreen TUI that reproduces the ONE condition plain bash never did in the test bed: an app
// that turns on mouse tracking (like claude's TUI). It goes to the alternate screen, enables mouse
// reporting (1000 + SGR 1006 — exactly what makes xterm disable selection), prints a few links WITHOUT a
// scheme, and echoes every wheel event it receives back onto a status line. So in the browser terminal
// you can verify, against a real mouse-reporting app:
//   • plain drag SELECTS (no Option)            — our output-stream mouse-tracking stripper
//   • a bare domain / localhost:port is CLICKABLE — our custom link providers
//   • the WHEEL still reaches the app             — our custom wheel forwarder (the counter ticks)
//
// Run it inside the test bed:  TERMBED_CMD='node ../scripts/mouse-tui.mjs' node scripts/termbed.mjs
// (or just `node scripts/mouse-tui.mjs` in any terminal to eyeball the escapes). Ctrl-C / q to quit.
const out = process.stdout
const w = (s) => out.write(s)

const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l'
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h', MOUSE_OFF = '\x1b[?1006l\x1b[?1000l'
const HIDE = '\x1b[?25l', SHOW = '\x1b[?25h'
const home = (r, c) => `\x1b[${r};${c}H`
const clear = '\x1b[2J'

let wheels = 0, lastEvt = '—'

function draw() {
  w(clear + home(1, 1))
  w('\x1b[1;38;5;39m mouse-tui \x1b[0m — reproduces claude\'s mouse-reporting TUI\r\n')
  w('\x1b[90m mouse tracking is ON (1000+1006), so without the fix xterm would refuse to select\x1b[0m\r\n\r\n')
  w(' Links to click (none carry a scheme except the first):\r\n')
  w('   1. full url    https://example.com/path?q=1\r\n')
  w('   2. bare domain example.com\r\n')
  w('   3. subdomain   docs.github.io/xterm\r\n')
  w('   4. localhost   localhost:5199/foo\r\n')
  w('   5. www         www.google.com\r\n')
  w('   6. not a link  Component.tsx:42  (should NOT underline)\r\n\r\n')
  w(' Drag across any line above → it should highlight and land on your clipboard.\r\n\r\n')
  w(`\x1b[7m WHEEL received: ${wheels}   last event: ${lastEvt}  \x1b[0m\r\n`)
  w('\r\n \x1b[90mscroll over the pane to tick the counter · press q or Ctrl-C to quit\x1b[0m')
}

function cleanup(code = 0) {
  w(MOUSE_OFF + SHOW + ALT_OFF)
  try { process.stdin.setRawMode(false) } catch { /* not a tty */ }
  process.exit(code)
}

w(ALT_ON + HIDE + MOUSE_ON)
draw()

try { process.stdin.setRawMode(true) } catch { /* not a tty — still readable */ }
process.stdin.resume()
process.stdin.on('data', (buf) => {
  const s = buf.toString('latin1')
  if (s === 'q' || s === '\x03') return cleanup(0) // q or Ctrl-C
  // SGR mouse: ESC [ < btn ; col ; row (M|m). Wheel up = 64, down = 65 (bit 0x40 set).
  const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s)
  if (m) {
    const btn = Number(m[1])
    if (btn === 64 || btn === 65) { wheels++; lastEvt = `${btn === 64 ? 'up' : 'down'} @ ${m[2]},${m[3]}`; draw() }
  }
})
process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))
