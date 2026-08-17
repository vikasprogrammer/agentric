/**
 * THE PROCESS JANITOR — reap `ttyd`/`tmux` processes nothing can ever reach again.
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
 * The predicate is provable, not heuristic: **a tmux socket path that no longer exists on disk can never be
 * connected to again**, so the ttyd fronting it is dead weight by definition. Three guards keep that from
 * becoming a way to shoot a live tenant:
 *   - our own uid + our own command shape only (`ttyd … attach.sh <sock>` / `tmux -S <sock>`),
 *   - never a socket a live runtime declares (belt to the on-disk check's braces),
 *   - missing on TWO consecutive sweeps and older than {@link MIN_AGE_MS}, so a socket being recreated
 *     mid-sweep is not mistaken for an abandoned one.
 *
 * Killing a zombie tmux server may kill a claude still running inside it. That work is already unreachable
 * — no attach, no gate, no recovery — so reaping is right, but the caller MUST audit the count: a janitor
 * that quietly cleans up after a leak hides the leak.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

/** Grace before a socket-less process is eligible, so a just-starting runtime is never caught. */
const MIN_AGE_MS = 10 * 60_000;

export interface OrphanSweepResult {
  /** Orphaned ttyd killed this sweep. */
  ttyd: number;
  /** Orphaned tmux servers killed this sweep. */
  tmux: number;
  /** Candidates seen missing but not yet killed (first strike, or inside the age grace). */
  pending: number;
}

interface Candidate {
  pid: number;
  kind: 'ttyd' | 'tmux';
  socket: string;
  ageMs: number;
}

export class ProcessJanitor {
  /** pids seen socket-less on the PREVIOUS sweep — the second-strike memory. */
  private strikes = new Set<number>();

  /**
   * @param liveSockets sockets currently claimed by a live runtime; never reaped even if the path check
   *                    somehow disagrees. Called fresh each sweep so a newly built tenant is respected.
   */
  constructor(private readonly liveSockets: () => Set<string>) {}

  sweep(): OrphanSweepResult {
    const out: OrphanSweepResult = { ttyd: 0, tmux: 0, pending: 0 };
    let candidates: Candidate[];
    try {
      candidates = this.scan();
    } catch {
      return out; // a failed `ps` means we know nothing; killing on a guess is the one unsafe move here
    }
    const live = this.liveSockets();
    const nextStrikes = new Set<number>();
    for (const c of candidates) {
      if (live.has(c.socket)) continue;                       // a running tenant owns it
      if (this.socketExists(c.socket)) continue;              // reachable — not our business
      if (c.ageMs < MIN_AGE_MS) { out.pending++; continue; }  // too young to call abandoned
      if (!this.strikes.has(c.pid)) { nextStrikes.add(c.pid); out.pending++; continue; } // first strike
      try {
        process.kill(c.pid, 'SIGTERM');
        out[c.kind]++;
      } catch {
        // already gone, or not ours to signal — either way nothing to reap
      }
    }
    this.strikes = nextStrikes;
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
   * Our own ttyd/tmux processes and the tmux socket each is bound to.
   *
   * `ps -A -o pid=,uid=,etime=,args=` is the portable spelling (GNU + BSD): no header, and `etime` rather
   * than Linux-only `etimes`. We filter to this process's uid, so the sweep can never touch another user's
   * terminal server on a shared box.
   */
  private scan(): Candidate[] {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,uid=,etime=,args='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (r.error || r.status !== 0 || !r.stdout) throw new Error('ps failed');
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const self = process.pid;
    const out: Candidate[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === self || (uid >= 0 && Number(m[2]) !== uid)) continue;
      const args = m[4];
      // ttyd is ours only when it fronts OUR attach script; a plain `ttyd -O login` service is untouched.
      const ttyd = args.match(/(?:^|\/)ttyd\s.*\/terminal\/attach\.sh\s+(\S+)/);
      // tmux server/client on an explicit socket — the `-S <path>` every runtime and harness passes.
      const tmux = ttyd ? null : args.match(/(?:^|\/)tmux\s.*-S\s+(\S+)/);
      const socket = ttyd?.[1] ?? tmux?.[1];
      if (!socket) continue;
      out.push({ pid, kind: ttyd ? 'ttyd' : 'tmux', socket, ageMs: parseEtime(m[3]) });
    }
    return out;
  }
}

/** Parse `ps` etime (`MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`) to ms. Unparseable → 0, i.e. treated as too young. */
export function parseEtime(etime: string): number {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime];
  const parts = clock.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  const [h, m, s] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return ((Number(days) * 24 + h) * 3600 + m * 60 + s) * 1000;
}
