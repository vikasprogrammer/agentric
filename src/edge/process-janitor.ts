/**
 * THE PROCESS JANITOR — reap `ttyd`/`tmux`/agent-shell processes nothing can ever reach again.
 *
 * Deliberately NOT part of the session reaper. `TerminalManager.reapIdleSessions` answers "is this RUN
 * still worth a pane" from `term_sessions` rows; this answers "is this OS PROCESS reachable by anything at
 * all", by scanning the process table. Mixing them would put a `ps` sweep inside a DB-driven reaper.
 *
 * Why it exists: a live box accumulated **86 orphaned ttyd (1604% CPU, load 92 on 12 cores)** and 27 zombie
 * tmux servers, up to 17 days old, from in-process test harnesses whose scratch homes had since been
 * `rm -rf`'d. Nothing in the OS swept them — the session reaper never knew their rows, and ttyd teardown
 * only ran on a graceful `TenantRegistry.stopAll()`. Every governed effect on that box — a gate check, a
 * task write, a console load — queued behind the resulting CPU starvation.
 *
 * Each predicate is provable, not heuristic.
 *
 * **ttyd / tmux** — *a tmux socket path that no longer exists on disk can never be connected to again*, so
 * the ttyd fronting it is dead weight by definition. Three guards keep that from becoming a way to shoot a
 * live tenant:
 *   - our own uid + our own command shape only (`ttyd … attach.sh <sock>` / `tmux -S <sock>`),
 *   - never a socket a live runtime declares (belt to the on-disk check's braces),
 *   - missing on TWO consecutive sweeps and older than {@link MIN_AGE_MS}, so a socket being recreated
 *     mid-sweep is not mistaken for an abandoned one.
 *
 * **Agent shells (`shell`)** — the same leak one layer down, and the one that bit the Mac Mini on
 * 2026-08-20: an agent ran a Go race test under deliberate CPU contention —
 * `(for i in $(seq 1 24); do (while :; do :; done) & done; go test …; jobs -p | xargs kill)` — and the
 * tool call died (timeout/reap) before the trailing `kill` ran. The 24 spinner subshells were reparented to
 * init and spun at ~30% CPU each for 1.5 days: **load 29 on 12 cores**, 882 CPU-minutes apiece. The
 * ttyd/tmux predicate could not see them (they hold no socket), and the session reaper could not either
 * (they are in no `term_sessions` row). The predicate here is `PPID == 1` on a process still carrying a
 * **claude-code Bash-tool argv** (`… -c … /shell-snapshots/snapshot-…`): that argv is minted per tool call
 * and only survives on a shell that forked WITHOUT exec'ing, so such a process is a subshell (or waiting
 * wrapper) whose spawning `claude` is gone — its output can never be delivered to any session, and no
 * `tmux kill-session` will ever reach it.
 *
 * That rules out the obvious false positive: a server an agent deliberately daemonised (`nohup npm run dev &`)
 * exec's, so its argv is `node …`, not the snapshot line, and it is never a candidate. Reaping the orphaned
 * *shell* also does not kill such a child — the child has its own pid and reparents independently.
 *
 * Killing a zombie tmux server may kill a claude still running inside it. That work is already unreachable
 * — no attach, no gate, no recovery — so reaping is right, but the caller MUST audit the count: a janitor
 * that quietly cleans up after a leak hides the leak.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

/** Grace before a socket-less process is eligible, so a just-starting runtime is never caught. */
const MIN_AGE_MS = 10 * 60_000;

/**
 * A claude-code Bash-tool shell: `<sh|bash|zsh> -c … /shell-snapshots/snapshot-…`. The marker sits at the
 * very front of the command (claude sources the snapshot first), so it survives `ps` argv truncation. Only
 * meaningful together with `PPID == 1` — with a live parent this is simply a tool call in flight.
 */
const AGENT_SHELL = /(?:^|\/)(?:ba|z)?sh\s+-c\b[\s\S]*\/shell-snapshots\/snapshot-/;

export interface OrphanSweepResult {
  /** Orphaned ttyd killed this sweep. */
  ttyd: number;
  /** Orphaned tmux servers killed this sweep. */
  tmux: number;
  /** Orphaned agent shells (claude-code Bash-tool shells reparented to init) killed this sweep. */
  shell: number;
  /** Candidates seen missing but not yet killed (first strike, or inside the age grace). */
  pending: number;
}

export interface Candidate {
  pid: number;
  kind: 'ttyd' | 'tmux' | 'shell';
  /** The tmux socket for `ttyd`/`tmux`. Empty for `shell`, whose predicate is PPID, not a socket. */
  socket: string;
  ageMs: number;
}

export class ProcessJanitor {
  /** pids seen unreachable on the PREVIOUS sweep — the second-strike memory. */
  private strikes = new Set<number>();
  /** pids already sent SIGTERM by a previous sweep; still present ⇒ escalate to SIGKILL. */
  private termed = new Set<number>();

  /**
   * @param liveSockets sockets currently claimed by a live runtime; never reaped even if the path check
   *                    somehow disagrees. Called fresh each sweep so a newly built tenant is respected.
   */
  constructor(private readonly liveSockets: () => Set<string>) {}

  sweep(): OrphanSweepResult {
    const out: OrphanSweepResult = { ttyd: 0, tmux: 0, shell: 0, pending: 0 };
    let candidates: Candidate[];
    try {
      candidates = this.scan();
    } catch {
      return out; // a failed `ps` means we know nothing; killing on a guess is the one unsafe move here
    }
    const live = this.liveSockets();
    const nextStrikes = new Set<number>();
    const nextTermed = new Set<number>();
    for (const c of candidates) {
      if (c.kind !== 'shell') {
        // Socket-backed kinds: reachable ⇒ not our business. An orphaned shell holds no socket; being
        // reparented to init IS its unreachability proof, so it skips straight to the age/strike guards.
        if (live.has(c.socket)) continue;                     // a running tenant owns it
        if (this.socketExists(c.socket)) continue;            // reachable — not our business
      }
      if (c.ageMs < MIN_AGE_MS) { out.pending++; continue; }  // too young to call abandoned
      if (!this.strikes.has(c.pid)) { nextStrikes.add(c.pid); out.pending++; continue; } // first strike
      // Escalate on a survivor: a spinning shell can be slow to service SIGTERM, and re-TERMing it every
      // sweep forever would leave the CPU burn in place while the counts claimed we had reaped it.
      const signal = this.termed.has(c.pid) ? 'SIGKILL' : 'SIGTERM';
      try {
        process.kill(c.pid, signal);
        nextStrikes.add(c.pid); // still listed next sweep ⇒ it survived; go straight to SIGKILL
        // Counted once per orphan, on the FIRST signal — an escalation is the same leak, not a new one,
        // and the counts are what the audit event uses to size the leak.
        if (signal === 'SIGTERM') { nextTermed.add(c.pid); out[c.kind]++; }
      } catch {
        // already gone, or not ours to signal — either way nothing to reap
      }
    }
    this.strikes = nextStrikes;
    this.termed = nextTermed;
    return out;
  }

  /** `true` when the path is a socket we could still connect to. Anything unreadable counts as gone. */
  private socketExists(socket: string): boolean {
    try {
      return fs.statSync(socket).isSocket();
    } catch {
      return false;
    }
  }

  /**
   * Our own ttyd/tmux processes (and the tmux socket each is bound to) plus orphaned agent shells.
   *
   * `ps -A -o pid=,ppid=,uid=,etime=,args=` is the portable spelling (GNU + BSD): no header, and `etime`
   * rather than Linux-only `etimes`. We filter to this process's uid, so the sweep can never touch another
   * user's terminal server on a shared box.
   *
   * `protected` so a test can drive {@link sweep} over a fixed process table.
   */
  protected scan(): Candidate[] {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,uid=,etime=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0 || !r.stdout) throw new Error('ps failed');
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    return parseProcessTable(r.stdout, uid, process.pid);
  }
}

/**
 * Pure `ps` → candidates, split out so the predicate is testable without a real process table.
 *
 * @param uid  reap only this uid's processes; `-1` disables the filter (no `getuid`, i.e. Windows).
 * @param self this process's pid — never a candidate.
 */
export function parseProcessTable(stdout: string, uid: number, self: number): Candidate[] {
  const out: Candidate[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (pid === self || (uid >= 0 && Number(m[3]) !== uid)) continue;
    const args = m[5];
    const ageMs = parseEtime(m[4]);
    // ttyd is ours only when it fronts OUR attach script; a plain `ttyd -O login` service is untouched.
    const ttyd = args.match(/(?:^|\/)ttyd\s.*\/terminal\/attach\.sh\s+(\S+)/);
    // tmux server/client on an explicit socket — the `-S <path>` every runtime and harness passes.
    const tmux = ttyd ? null : args.match(/(?:^|\/)tmux\s.*-S\s+(\S+)/);
    const socket = ttyd?.[1] ?? tmux?.[1];
    if (socket) {
      out.push({ pid, kind: ttyd ? 'ttyd' : 'tmux', socket, ageMs });
      continue;
    }
    // An agent shell is a candidate ONLY once reparented to init: with a live parent it is a tool call in
    // flight, and the same argv shape is exactly what a healthy session looks like mid-Bash.
    if (ppid === 1 && AGENT_SHELL.test(args)) out.push({ pid, kind: 'shell', socket: '', ageMs });
  }
  return out;
}

/** Parse `ps` etime (`MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`) to ms. Unparseable → 0, i.e. treated as too young. */
export function parseEtime(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = clock.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return ((Number(days) * 24 + h) * 3600 + m * 60 + s) * 1000;
}
