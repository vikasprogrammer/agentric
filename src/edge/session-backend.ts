/**
 * Where a session's tmux shell actually runs — the seam behind the `AOS_UID_ISOLATION` flag.
 *
 *  - LocalSessionBackend (default / flag off): one shared tmux socket, spawned as the app's own uid.
 *    This reproduces the historical behavior exactly (a `KEY='v' … bash '<script>'` command string).
 *  - LauncherSessionBackend (flag on): the session runs as the spawning member's OWN uid via the
 *    privileged Phase A launcher, on that member's private (0700) tmux socket — so members can't read
 *    each other's shells/tokens at the OS level.
 *
 * The app builds `{env, argv}` once (TerminalManager); each backend consumes it its own way: the local
 * one serializes back to a shell string, the launcher one hands the object+argv to the daemon (which
 * sets `--setenv=K=V` and execs with no shell). `space` is the member-uid identity (ignored locally).
 */
import { spawn, spawnSync } from 'child_process';
import { LauncherClient } from './launcher';

export interface SpawnSpec {
  sessionId: string;
  agent: string;
  tmuxName: string;
  env: Record<string, string>;
  /** The in-session command, e.g. `['bash', '/abs/terminal/claude-launch.sh']`. */
  argv: string[];
  /** Per-session file CONTENTS the runner reads: the `.mcp.json` (connectors) + company markdown.
   *  Each backend materialises them somewhere the session can read (local dir vs the member home). */
  files?: { mcp?: string; company?: string };
  /** The shared agent source dir. Under the launcher it's copied to a per-member working dir (so the
   *  member uid can write claude's `.claude/`/scratch); the local backend ignores it (claude runs as
   *  the app uid directly in the source dir, as today). */
  agentSrc?: string;
}
export type SpawnErrorSink = (sessionId: string, agent: string, error: string) => void;

export interface SessionBackend {
  spawn(space: string, spec: SpawnSpec): void;
  kill(space: string, tmuxName: string): void;
  /** Type `text` into a live session's pty (tmux send-keys), optionally pressing Enter to submit.
   *  Used to hand a running claude a reference (e.g. the path of a console-uploaded image). Returns
   *  false if the inject couldn't be delivered (no session, or backend can't reach the socket). */
  injectText(space: string, tmuxName: string, text: string, submit: boolean): boolean;
  /** Live tmux session names, or null when liveness can't be polled (→ rely on end signals). */
  aliveNames(): Set<string> | null;
  /**
   * Ensure a browser can attach to `tmuxName` and return the iframe URL. Local → the classic shared
   * `/terminal/?arg=…` (one ttyd). Launcher → bring up the member's own ttyd and return a
   * per-member `/terminal/<space>/?arg=…` (the app reverse-proxies that path to the member's port).
   */
  attachUrl(space: string, tmuxName: string): Promise<string>;
  /** The ttyd loopback port serving `space`, if one is up (launcher only) — for the reverse proxy. */
  ttydPortFor(space: string): number | undefined;
  /** Spaces this backend currently has live holders/ttyds for — the idle-GC sweep set ([] for local). */
  managedSpaces(): string[];
  /** Tear down a space (stop its ttyd + holder, free its port) — idle GC. No-op for local. */
  release(space: string): void;
}

const TERMINAL_URL = (segment: string | null, tmuxName: string): string =>
  segment
    ? `/terminal/${encodeURIComponent(segment)}/?arg=${encodeURIComponent(tmuxName)}`
    : `/terminal/?arg=${encodeURIComponent(tmuxName)}`;

const TMUX_GEOMETRY = ['-x', '203', '-y', '50'];

/** POSIX single-quote a value for a `KEY='value'` shell assignment (handles embedded quotes). */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Today's behavior: one socket, spawned as the app uid, command assembled as a single shell string.
 *  Per-session files are materialised by TerminalManager (in the app dir) and already in spec.env as
 *  MCP_CONFIG/COMPANY_FILE — the session runs as the app uid, so it can read them. spec.files (the raw
 *  contents) is only consumed by the launcher backend, which writes them into the member's home. */
export class LocalSessionBackend implements SessionBackend {
  constructor(private readonly tmuxSocket: string, private readonly onError: SpawnErrorSink) {}

  spawn(_space: string, spec: SpawnSpec): void {
    // tmux + the claude TUI need a UTF-8 locale or wide chars (the ┌─ banners, ✅⛔ glyphs, the spinner)
    // get mangled — tmux decides UTF-8 mode by string-matching LC_ALL/LC_CTYPE/LANG for "UTF-8". A
    // launchd/systemd-launched server inherits a minimal env with no LANG (→ C/POSIX = ASCII), so
    // default one here unless the caller set it. This covers the pane + claude; the rendering client
    // (ttyd's `tmux attach`) is forced UTF-8 separately via `tmux -u` in attach.sh.
    const env = { LANG: 'en_US.UTF-8', ...spec.env };
    const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(' ');
    const cmd = spec.argv.map((a, i) => (i === 0 ? a : sq(a))).join(' '); // argv[0] (bash) bare, rest quoted
    const full = envPrefix ? `${envPrefix} ${cmd}` : cmd;
    // -u: assert the terminal is UTF-8 regardless of the locale tmux itself was started under.
    const args = ['-u', '-S', this.tmuxSocket, 'new-session', '-d', '-s', spec.tmuxName, ...TMUX_GEOMETRY, full];
    const child = spawn('tmux', args, { stdio: 'ignore' });
    child.on('error', (e) => this.onError(spec.sessionId, spec.agent, String(e)));
    // Server-wide tmux tuning recommended for the claude TUI: allow-passthrough lets the agent's
    // progress/notification escapes reach the browser terminal instead of being swallowed; the
    // extended-keys pair lets tmux distinguish Shift+Enter from Enter so the newline shortcut works;
    // set-clipboard on lets claude's copy-on-select OSC 52 escape reach the browser terminal so a
    // selection in the TUI lands on the USER's browser clipboard (claude DCS-wraps it for the
    // passthrough path, and forwards the raw variant too — this covers both). Global + idempotent, so
    // re-applying per spawn is harmless; older tmux may reject an option → stdio is ignored so it can't
    // break a session.
    // mouse on: the WHEEL scrolls tmux's scrollback at a bare shell prompt (e.g. claude's resume screen);
    // a running claude that requests its own mouse mode still gets the wheel forwarded to it, so its
    // in-app scroll is unchanged. mode-style paints the selection blue to match the console's <Xterm>;
    // MouseDragEnd copy-selection-no-clear copies (→ OSC 52 → clipboard) WITHOUT clearing the highlight.
    for (const opt of [['set', '-g', 'allow-passthrough', 'on'], ['set', '-s', 'extended-keys', 'on'],
                       ['set', '-g', 'set-clipboard', 'on'],
                       ['set', '-as', 'terminal-features', 'xterm*:extkeys'],
                       ['set', '-g', 'mouse', 'on'],
                       ['set', '-g', 'mode-style', 'bg=#2563eb,fg=#ffffff'],
                       ['bind', '-T', 'copy-mode', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear'],
                       ['bind', '-T', 'copy-mode-vi', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear']]) {
      spawnSync('tmux', ['-S', this.tmuxSocket, ...opt], { stdio: 'ignore' });
    }
  }

  kill(_space: string, tmuxName: string): void {
    spawnSync('tmux', ['-S', this.tmuxSocket, 'kill-session', '-t', tmuxName], { stdio: 'ignore' });
  }

  injectText(_space: string, tmuxName: string, text: string, submit: boolean): boolean {
    // `-l` = literal: send the bytes as typed, not as tmux key names (a path could contain `;`, `-`,
    // etc.). Submit is a SEPARATE send-keys with the `Enter` key name so it's interpreted as a return.
    const r = spawnSync('tmux', ['-S', this.tmuxSocket, 'send-keys', '-t', tmuxName, '-l', text], { stdio: 'ignore' });
    if (r.status !== 0) return false;
    if (submit) spawnSync('tmux', ['-S', this.tmuxSocket, 'send-keys', '-t', tmuxName, 'Enter'], { stdio: 'ignore' });
    return true;
  }

  aliveNames(): Set<string> | null {
    const r = spawnSync('tmux', ['-S', this.tmuxSocket, 'list-sessions', '-F', '#S'], { encoding: 'utf8' });
    // Distinguish "couldn't run the poll" from "tmux answered, no sessions". A transient spawn
    // failure (EAGAIN/ENOMEM/EMFILE under fork/memory pressure) sets r.error; treat that as UNKNOWN
    // (null) so the caller does NOT reap — otherwise one hiccup flips every live session to idle and,
    // since the sweep only ever goes running→idle, they stay falsely gray. A non-zero exit with no
    // error is tmux itself reporting no server/sessions → genuinely empty, safe to reap.
    if (r.error) return null;
    if (r.status !== 0) return new Set();
    return new Set((r.stdout || '').split('\n').filter(Boolean));
  }

  async attachUrl(_space: string, tmuxName: string): Promise<string> {
    return TERMINAL_URL(null, tmuxName); // the single shared ttyd, fronted by nginx as today
  }
  ttydPortFor(_space: string): number | undefined {
    return undefined; // no per-member ttyd / app proxy in local mode
  }
  managedSpaces(): string[] { return []; }
  release(_space: string): void { /* nothing per-member to tear down locally */ }
}

const TTYD_PORT_MIN = 7700;
const TTYD_PORT_MAX = 7999;

/** Phase A: run the session as the member's own uid via the privileged launcher (per-member socket). */
export class LauncherSessionBackend implements SessionBackend {
  /** space → the loopback ttyd port we allocated for that member. */
  private readonly ports = new Map<string, number>();
  /** Every space we've brought a holder/ttyd up for — the idle-GC candidate set. */
  private readonly seen = new Set<string>();

  constructor(private readonly client: LauncherClient, private readonly onError: SpawnErrorSink) {}

  /** Stable per-space ttyd port (allocated once, reused across attaches). */
  private portFor(space: string): number {
    const have = this.ports.get(space);
    if (have) return have;
    const used = new Set(this.ports.values());
    for (let p = TTYD_PORT_MIN; p <= TTYD_PORT_MAX; p++) {
      if (!used.has(p)) {
        this.ports.set(space, p);
        return p;
      }
    }
    throw new Error('no free ttyd port');
  }

  spawn(space: string, spec: SpawnSpec): void {
    this.seen.add(space);
    // Fire-and-forget (like the local spawn) — surface only failures to the audit log. The launcher
    // writes spec.files into the member home (member-readable) and sets MCP_CONFIG/COMPANY_FILE/LOG_DIR.
    this.client
      .startSession(space, spec.sessionId, spec.tmuxName, spec.env, spec.argv, { files: spec.files, agent: spec.agent, agentSrc: spec.agentSrc })
      .then((r) => { if (!r.ok) this.onError(spec.sessionId, spec.agent, r.error ?? 'launcher start failed'); })
      .catch((e) => this.onError(spec.sessionId, spec.agent, String(e)));
  }

  kill(space: string, tmuxName: string): void {
    void this.client.stopSession(space, tmuxName).catch(() => undefined);
  }

  injectText(_space: string, _tmuxName: string, _text: string, _submit: boolean): boolean {
    // Under uid isolation the session's tmux lives on a member-private (0700) socket the app can't
    // reach; injecting would need a launcher verb. Not yet supported — callers degrade gracefully
    // (the file is still saved; only the auto-typed reference is skipped).
    return false;
  }

  aliveNames(): Set<string> | null {
    // Per-member sockets are uid-private (0700) — the app can't poll them. Launcher-spawned sessions
    // flip to idle via the explicit /api/ended + /api/report signals; precise launcher-side liveness
    // (a `list_sessions` verb) is a later refinement.
    return null;
  }

  async attachUrl(space: string, tmuxName: string): Promise<string> {
    // Bring up (idempotently) the member's own ttyd on its allocated port; the app reverse-proxies
    // /terminal/<space>/ → that port. The launcher runs ttyd AS the member uid on their private socket.
    this.seen.add(space);
    const port = this.portFor(space);
    const r = await this.client.ttydUp(space, port);
    if (!r.ok) throw new Error(r.error ?? 'ttyd start failed');
    return TERMINAL_URL(space, tmuxName);
  }
  ttydPortFor(space: string): number | undefined {
    return this.ports.get(space);
  }
  managedSpaces(): string[] {
    return [...this.seen];
  }
  release(space: string): void {
    this.seen.delete(space);
    this.ports.delete(space);
    void this.client.ttydDown(space).catch(() => undefined);
    void this.client.releaseMember(space).catch(() => undefined);
  }
}
