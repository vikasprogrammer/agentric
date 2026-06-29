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
    const envPrefix = Object.entries(spec.env).map(([k, v]) => `${k}=${sq(v)}`).join(' ');
    const cmd = spec.argv.map((a, i) => (i === 0 ? a : sq(a))).join(' '); // argv[0] (bash) bare, rest quoted
    const full = envPrefix ? `${envPrefix} ${cmd}` : cmd;
    const args = ['-S', this.tmuxSocket, 'new-session', '-d', '-s', spec.tmuxName, ...TMUX_GEOMETRY, full];
    const child = spawn('tmux', args, { stdio: 'ignore' });
    child.on('error', (e) => this.onError(spec.sessionId, spec.agent, String(e)));
    // Server-wide tmux tuning recommended for the claude TUI: allow-passthrough lets the agent's
    // progress/notification escapes reach the browser terminal instead of being swallowed; the
    // extended-keys pair lets tmux distinguish Shift+Enter from Enter so the newline shortcut works.
    // Global + idempotent, so re-applying per spawn is harmless; older tmux may reject an option →
    // stdio is ignored so it can't break a session. (Mouse-wheel scroll is fixed separately by
    // CLAUDE_CODE_NO_FLICKER in claude-launch.sh, which puts the TUI on the alternate screen.)
    for (const opt of [['set', '-g', 'allow-passthrough', 'on'], ['set', '-s', 'extended-keys', 'on'],
                       ['set', '-as', 'terminal-features', 'xterm*:extkeys']]) {
      spawnSync('tmux', ['-S', this.tmuxSocket, ...opt], { stdio: 'ignore' });
    }
  }

  kill(_space: string, tmuxName: string): void {
    spawnSync('tmux', ['-S', this.tmuxSocket, 'kill-session', '-t', tmuxName], { stdio: 'ignore' });
  }

  aliveNames(): Set<string> | null {
    const r = spawnSync('tmux', ['-S', this.tmuxSocket, 'list-sessions', '-F', '#S'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) return new Set();
    return new Set(r.stdout.split('\n').filter(Boolean));
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
