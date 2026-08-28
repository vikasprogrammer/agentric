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
  /** Per-session file CONTENTS the runner reads: the `.mcp.json` (connectors), company markdown, and the
   *  opening task prompt. Each backend materialises them somewhere the session can read (local dir vs the
   *  member home). The task rides as a file (not inline env) so a large prompt can't overflow tmux's
   *  new-session command-length cap — see launchClaudeCode. */
  files?: { mcp?: string; company?: string; task?: string };
  /** The shared agent source dir. Under the launcher it's copied to a per-member working dir (so the
   *  member uid can write claude's `.claude/`/scratch); the local backend ignores it (claude runs as
   *  the app uid directly in the source dir, as today). */
  agentSrc?: string;
  /** Override the pane's column count. Agent sessions never set it (a human attaches to them, and the
   *  default matches the console terminal), but a pane the app only ever READS wants to be wide enough
   *  that the TUI doesn't hard-wrap what we're scraping: a CLI wraps to ITS terminal width and emits real
   *  line breaks, which `capture-pane -J` cannot rejoin (it only rejoins tmux's own soft wraps). The
   *  guided-login flow sets it so the OAuth URL arrives in one piece. */
  cols?: number;
}
export type SpawnErrorSink = (sessionId: string, agent: string, error: string) => void;

export interface SessionBackend {
  spawn(space: string, spec: SpawnSpec): void;
  kill(space: string, tmuxName: string): void;
  /** Type `text` into a live session's pty (tmux send-keys), optionally pressing Enter to submit.
   *  Used to hand a running claude a reference (e.g. the path of a console-uploaded image). Returns
   *  false if the inject couldn't be delivered (no session, or backend can't reach the socket). */
  /** Type into a live pane. `verify` (default true) asks the backend to CONFIRM the text became a turn
   *  rather than parking in the composer; pass false when the session is mid-turn, where parking is the
   *  correct behaviour and confirming it would report a working agent as failed. */
  /** `enterPresses` (default {@link SUBMIT_ATTEMPTS}) is how many times Enter is pressed after the text
   *  settles. Two is right for an agent composer, where a swallowed Enter parks the message. It is WRONG
   *  for a one-shot CLI prompt: there the second Enter lands on whatever screen the first produced — on
   *  claude's login that is "Press Enter to retry", so the stray press silently re-armed the flow with a
   *  fresh PKCE challenge while the console still showed the old link. Pass 1 for prompts like that. */
  injectText(space: string, tmuxName: string, text: string, submit: boolean, verify?: boolean, enterPresses?: number): boolean;
  /** Live tmux session names, or null when liveness can't be polled (→ rely on end signals). */
  aliveNames(): Set<string> | null;
  /** Per-session resident memory: tmux session name → summed RSS **in KiB** of that session's pane
   *  process tree (the shell + `claude`/node + its MCP subprocesses). Approximate — RSS counts shared
   *  pages (libraries) once per process, so a sum over the tree slightly over-reports. `null` when it
   *  can't be measured (launcher backend: uid-private sockets the app can't inspect). */
  sessionRss(): Map<string, number> | null;
  /** Is a browser terminal currently ATTACHED to `tmuxName` (tmux has ≥1 client on the session)?
   *  Distinguishes "a human is watching this live pane" from "running but unobserved" — the signal the
   *  turn-end/idle reapers use to leave a taken-over run alone. `null` when it can't be determined
   *  (launcher backend: the member's tmux socket is uid-private) → callers fall back to timeout reaping. */
  hasClient(space: string, tmuxName: string): boolean | null;
  /** Snapshot the visible scrollback of `tmuxName` as text (tmux capture-pane, full history), for the
   *  console's "what did this run do" transcript view once its pane is gone. `null` when unavailable
   *  (no such session, or the socket can't be reached). Replaces the old `-p` stdout tee. */
  capturePane(space: string, tmuxName: string): string | null;
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

/** How long to let a `send-keys -l` settle before the submit `Enter`, doubled on the retry. An agent TUI
 *  reads a large send as a bracketed paste and absorbs an Enter that arrives mid-assembly. */
const PASTE_SETTLE_MS = 350;
/** Submit attempts before `injectText` admits the message never became a turn. */
const SUBMIT_ATTEMPTS = 2;
/** How long a tmux liveness poll may be reused before re-execing tmux — see {@link LocalSessionBackend.aliveNames}.
 *  Invalidated eagerly on spawn/kill, so this bounds only how stale an UNCHANGED-by-us world may read. */
const ALIVE_POLL_TTL_MS = 1_000;

/** Block this thread for `ms`. The backend contract is synchronous, and the settle has to happen BETWEEN
 *  two tmux calls, so there is nowhere to await. Bounded by PASTE_SETTLE_MS × SUBMIT_ATTEMPTS (~1s). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** POSIX single-quote a value for a `KEY='value'` shell assignment (handles embedded quotes). */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Today's behavior: one socket, spawned as the app uid, command assembled as a single shell string.
 *  Per-session files are materialised by TerminalManager (in the app dir) and already in spec.env as
 *  MCP_CONFIG/COMPANY_FILE — the session runs as the app uid, so it can read them. spec.files (the raw
 *  contents) is only consumed by the launcher backend, which writes them into the member's home. */
export class LocalSessionBackend implements SessionBackend {
  /** Last {@link aliveNames} answer + when it was taken — see the TTL note on that method. */
  private alivePoll?: { at: number; names: Set<string> | null };

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
    const geometry = spec.cols ? ['-x', String(spec.cols), '-y', '50'] : TMUX_GEOMETRY;
    const args = ['-u', '-S', this.tmuxSocket, 'new-session', '-d', '-s', spec.tmuxName, ...geometry, full];
    const child = spawn('tmux', args, { stdio: 'ignore' });
    child.on('error', (e) => this.onError(spec.sessionId, spec.agent, String(e)));
    this.alivePoll = undefined; // a new pane is appearing — don't let a cached poll call it dead
    // Server-wide tmux tuning recommended for the claude TUI: allow-passthrough lets the agent's
    // progress/notification escapes reach the browser terminal instead of being swallowed; the
    // extended-keys pair lets tmux distinguish Shift+Enter from Enter so the newline shortcut works;
    // set-clipboard on lets claude's copy-on-select OSC 52 escape reach the browser terminal so a
    // selection in the TUI lands on the USER's browser clipboard (claude DCS-wraps it for the
    // passthrough path, and forwards the raw variant too — this covers both). The `hyperlinks`
    // terminal-feature tells tmux the outer terminal (our xterm.js) understands OSC 8 — WITHOUT it tmux
    // STRIPS every OSC-8 hyperlink, so claude's markdown links never reach the browser and aren't
    // clickable (plain-text URLs still are, via <Xterm>'s link matchers). Global + idempotent, so
    // re-applying per spawn is harmless; older tmux may reject an option → stdio is ignored so it can't
    // break a session.
    // mouse on: the WHEEL scrolls tmux's scrollback at a bare shell prompt (e.g. claude's resume screen);
    // a running claude that requests its own mouse mode still gets the wheel forwarded to it, so its
    // in-app scroll is unchanged. mode-style paints the selection blue to match the console's <Xterm>;
    // MouseDragEnd copy-selection-no-clear copies (→ OSC 52 → clipboard) WITHOUT clearing the highlight.
    for (const opt of [['set', '-g', 'allow-passthrough', 'on'], ['set', '-s', 'extended-keys', 'on'],
                       ['set', '-g', 'set-clipboard', 'on'],
                       ['set', '-as', 'terminal-features', 'xterm*:extkeys:hyperlinks'],
                       ['set', '-g', 'mouse', 'on'],
                       ['set', '-g', 'mode-style', 'bg=#2563eb,fg=#ffffff'],
                       ['bind', '-T', 'copy-mode', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear'],
                       ['bind', '-T', 'copy-mode-vi', 'MouseDragEnd1Pane', 'send-keys', '-X', 'copy-selection-no-clear']]) {
      spawnSync('tmux', ['-S', this.tmuxSocket, ...opt], { stdio: 'ignore' });
    }
  }

  kill(_space: string, tmuxName: string): void {
    spawnSync('tmux', ['-S', this.tmuxSocket, 'kill-session', '-t', tmuxName], { stdio: 'ignore' });
    this.alivePoll = undefined; // we just changed the world — the next reader must see it
  }

  /**
   * Type `text` into a live pane, optionally submitting it as a turn.
   *
   * The mechanism that matters is the SETTLE: an agent TUI collapses a large `send-keys -l` into a
   * bracketed paste (`[Pasted text #N]`), and a submit `Enter` fired in the same instant is swallowed by
   * the still-assembling paste, leaving the message unsent in the composer. northwind 2026-08-17: 8
   * wake-ups parked across two agents' input boxes, each recorded `delivered` and never retried, until a
   * human pressed Enter and all of them ran at once. Settling and then pressing Enter — twice, with a
   * longer pause the second time — is what a human's late Enter does, and it is why this loop exists.
   *
   * It does NOT try to confirm the outcome by reading the pane, and two live incidents say why. A claude
   * TUI renders a SUBMITTED message with the same `❯` prompt glyph (and the same paste chip) that a parked
   * one has, so a single capture cannot tell "still in the composer" from "sent and echoed above it"; and
   * a MID-TURN agent parks injected text on purpose until its turn boundary, which is correct behaviour
   * that looked identical to failure. Acting on that guess stopped two working runs (`ses_987f7efc`,
   * `ses_1171820b`) to `--resume` them. A silent late delivery is recoverable; killing a live run is not,
   * so this returns whether the KEYSTROKES were delivered and leaves the verdict to a signal that can
   * actually carry it — see `docs/tasks-plan.md` §3.6 for the transcript-based check that should replace
   * this comment.
   */
  injectText(_space: string, tmuxName: string, text: string, submit: boolean, _verify = true, enterPresses = SUBMIT_ATTEMPTS): boolean {
    // `-l` = literal: send the bytes as typed, not as tmux key names (a path could contain `;`, `-`,
    // etc.). Submit is a SEPARATE send-keys with the `Enter` key name so it's interpreted as a return.
    const r = spawnSync('tmux', ['-S', this.tmuxSocket, 'send-keys', '-t', tmuxName, '-l', text], { stdio: 'ignore' });
    if (r.status !== 0) return false;
    if (!submit) return true;
    for (let attempt = 1; attempt <= Math.max(1, enterPresses); attempt++) {
      sleepSync(PASTE_SETTLE_MS * attempt);   // let the paste finish assembling before the Enter lands
      spawnSync('tmux', ['-S', this.tmuxSocket, 'send-keys', '-t', tmuxName, 'Enter'], { stdio: 'ignore' });
    }
    return true;
  }

  /**
   * The live tmux session names — the liveness primitive every reaper, guard and list endpoint reads.
   *
   * Memoized for {@link ALIVE_POLL_TTL_MS}, because the poll is a `spawnSync` and the process-wide cost is
   * set by how OFTEN it's called, not by how long tmux takes. On the live fleet a single scheduler tick
   * called it ~900 times (one per `task:` session row — see the per-row loop this TTL now absorbs in
   * `Automations.dispatchTasks`): tmux itself answered in ~0ms each, but 900 fork+execs cost **7.3s of a
   * 20s tick**, i.e. the server was blocked more than a third of all wall-clock. `/health` — a route that
   * does nothing but read a version string — measured p50 0.6ms / max 9s against that.
   *
   * A TTL is safe where a fresh exec is not any more truthful: tmux liveness changes on its own schedule,
   * every caller already treats the answer as a snapshot (a pane can die the instant after the poll
   * returns), and every reap decision built on it uses minute-scale cutoffs. One second is far below the
   * smallest of those and far above a tick's worth of repeat calls. `null` (poll couldn't run) is cached
   * too — the fail-safe "reap nothing" answer must be as cheap as the happy path under fork pressure.
   */
  aliveNames(): Set<string> | null {
    const cached = this.alivePoll;
    if (cached && Date.now() - cached.at < ALIVE_POLL_TTL_MS) return cached.names;
    const names = this.pollAliveNames();
    this.alivePoll = { at: Date.now(), names };
    return names;
  }

  private pollAliveNames(): Set<string> | null {
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

  sessionRss(): Map<string, number> | null {
    // One tmux call maps every live pane to its root PID; one `ps` snapshot gives the whole process
    // table. We then sum RSS over each pane's subtree (the shell → node/claude → MCP children).
    // `-Ao pid=,ppid=,rss=` is portable across BSD (macOS) and GNU (Linux) ps; RSS is KiB on both.
    const panes = spawnSync('tmux', ['-S', this.tmuxSocket, 'list-panes', '-a', '-F', '#{session_name} #{pane_pid}'], { encoding: 'utf8' });
    if (panes.error) return null;                 // couldn't poll tmux → unknown
    if (panes.status !== 0) return new Map();      // no server / no sessions → nothing to measure
    const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    if (ps.error || ps.status !== 0) return null;

    // Build pid → rss (KiB) and ppid → [children].
    const rssOf = new Map<number, number>();
    const kids = new Map<number, number[]>();
    for (const line of (ps.stdout || '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2], rss = +m[3];
      rssOf.set(pid, rss);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid);
    }
    const subtreeRss = (root: number): number => {
      let total = 0;
      const stack = [root];
      const seen = new Set<number>();
      while (stack.length) {
        const pid = stack.pop()!;
        if (seen.has(pid)) continue;               // cycle guard (ppid reuse after a wrap is possible)
        seen.add(pid);
        total += rssOf.get(pid) ?? 0;
        for (const c of kids.get(pid) ?? []) stack.push(c);
      }
      return total;
    };

    const out = new Map<string, number>();
    for (const line of (panes.stdout || '').split('\n')) {
      const sp = line.lastIndexOf(' ');
      if (sp < 0) continue;
      const name = line.slice(0, sp);
      const pid = +line.slice(sp + 1);
      if (!name || !Number.isFinite(pid)) continue;
      out.set(name, (out.get(name) ?? 0) + subtreeRss(pid)); // a session may (rarely) have >1 pane
    }
    return out;
  }

  hasClient(_space: string, tmuxName: string): boolean | null {
    // `list-clients -t <session>` prints one line per attached ttyd/xterm client; empty → nobody watching.
    const r = spawnSync('tmux', ['-S', this.tmuxSocket, 'list-clients', '-t', tmuxName, '-F', '#{client_name}'], { encoding: 'utf8' });
    if (r.error) return null;              // couldn't poll → unknown (don't reap on a hiccup)
    if (r.status !== 0) return false;      // no such session / no server → nothing attached
    return (r.stdout || '').split('\n').some(Boolean);
  }

  capturePane(_space: string, tmuxName: string): string | null {
    // -p: print to stdout; -J: join wrapped lines; -S -: from the start of the scrollback history.
    const r = spawnSync('tmux', ['-S', this.tmuxSocket, 'capture-pane', '-p', '-J', '-S', '-', '-t', tmuxName], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    return r.stdout || '';
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
    // writes spec.files into the member home (member-readable) and sets MCP_CONFIG/COMPANY_FILE.
    this.client
      .startSession(space, spec.sessionId, spec.tmuxName, spec.env, spec.argv, { files: spec.files, agent: spec.agent, agentSrc: spec.agentSrc })
      .then((r) => { if (!r.ok) this.onError(spec.sessionId, spec.agent, r.error ?? 'launcher start failed'); })
      .catch((e) => this.onError(spec.sessionId, spec.agent, String(e)));
  }

  kill(space: string, tmuxName: string): void {
    void this.client.stopSession(space, tmuxName).catch(() => undefined);
  }

  injectText(_space: string, _tmuxName: string, _text: string, _submit: boolean, _verify?: boolean, _enterPresses?: number): boolean {
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

  sessionRss(): Map<string, number> | null {
    return null; // uid-private sockets — the app can't inspect member process trees (a launcher verb later).
  }

  hasClient(_space: string, _tmuxName: string): boolean | null {
    return null; // uid-private socket — attachment can't be polled from the app (→ timeout-reap fallback).
  }

  capturePane(_space: string, _tmuxName: string): string | null {
    return null; // uid-private socket — the app can't capture the pane (a launcher verb is a later refinement).
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
