/**
 * Run a child process WITHOUT stopping the event loop.
 *
 * The product had four paths that shelled out with `spawnSync` and a ten-minute timeout — the self-update
 * apply (`git pull`, two `npm install`s, two builds), the dependency installer, the npm-dep upgrade — so a
 * single click could hold the whole single-threaded process, every tenant on the box included, for as long
 * as a package install takes. Nothing else in the process ran: no poll answered, no gate decision, no
 * scheduler tick. That is the largest blocking budget in the codebase by two orders of magnitude, and it
 * is exactly the shape of the unexplained multi-minute event-loop stalls the metrics kept reporting.
 *
 * `spawnSync` stays fine for the short probes it was chosen for (`command -v`, `--version`, `tmux
 * list-sessions` — single-digit ms, and the callers are synchronous by contract). This is for the long ones.
 */
import { spawn } from 'child_process';

export interface RunResult {
  /** Exit status, or null when the process was killed (timeout/signal). */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the spawn itself failed (ENOENT) or the timeout fired. */
  error?: Error;
  /** True when `timeout` elapsed and the child was killed. */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this many ms (default 10 minutes, matching the old spawnSync timeouts). */
  timeout?: number;
  /** Cap on captured output per stream; the tail is what a log needs, so the HEAD is dropped. */
  maxBuffer?: number;
}

/** Await a child process, capturing stdout/stderr as utf8. Never rejects — the result carries the failure. */
export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cwd, env, timeout = 10 * 60_000, maxBuffer = 16 * 1024 * 1024 } = opts;
  return new Promise<RunResult>((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    const finish = (status: number | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout: out, stderr: err, error, timedOut });
    };
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Keep the TAIL of a chatty install, the same half the old `out.slice(-4000)` callers wanted.
    const append = (buf: string, chunk: string): string => {
      const next = buf + chunk;
      return next.length > maxBuffer ? next.slice(next.length - maxBuffer) : next;
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { out = append(out, c); });
    child.stderr?.on('data', (c: string) => { err = append(err, c); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    timer.unref?.();
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}
