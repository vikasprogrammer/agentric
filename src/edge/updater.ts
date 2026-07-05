/**
 * Self-update — the deployment is a git checkout (this Mac Mini under launchd `com.agentos.<tenant>`,
 * or a Linux/systemd box), so "is a new version out?" reduces to "is my checkout behind its tracking
 * branch?" and "update" = fast-forward pull → rebuild (server + web) → restart. Everything is git-based:
 * no GitHub API, no outbound to a third party beyond `git fetch` against the origin the box already
 * clones from — it works on the private Tailscale box.
 *
 * Detection (`checkForUpdate`): `git fetch`, then compare HEAD against the upstream ref; the latest
 * version string is read from the tracking branch's package.json, and the commit subjects that would
 * land become the changelog preview. Result is cached (10-min TTL) so the console can poll it cheaply.
 *
 * Apply (`applyUpdate`, owner-only at the route): refuse on a dirty tree (an ff-only pull would fail
 * half-way), then `git pull --ff-only` → `npm install`+`npm run build` → web `npm install`+`npm run
 * build`, collecting each step's log. On success it schedules the restart *after* the HTTP response so
 * the caller gets the log; the service manager (launchd/systemd) respawns the process, so bouncing the
 * process we're running in is safe. Override the restart with `AOS_RESTART_CMD` (or the label/unit env).
 *
 * The git repo is process-wide (shared by every tenant in a multi-tenant runtime), so the cache is a
 * module-level singleton rather than per-tenant.
 */
import { spawnSync, spawn } from 'child_process';
import * as path from 'path';
import { VERSION } from '../version';

// dist/edge/updater.js → repo root is two directories up (mirrors version.ts resolving ../package.json).
const REPO_ROOT = path.join(__dirname, '..', '..');
const CHECK_TTL_MS = 10 * 60_000;

export interface UpdateStatus {
  /** The version this running process reports (package.json at boot). */
  current: string;
  /** The version on the tracking branch — equals `current` when up to date. */
  latest: string;
  /** How many commits HEAD is behind its upstream. `updateAvailable` === behind > 0. */
  behind: number;
  updateAvailable: boolean;
  /** The checked-out branch and its tracking ref (e.g. `main` / `origin/main`). */
  branch: string;
  upstream: string;
  /** Uncommitted changes present — an ff-only apply would fail, so the UI disables the button. */
  dirty: boolean;
  /** ms epoch of the last successful `git fetch`. */
  checkedAt: number;
  /** Newest-first commit subjects that would land on update (≤20), as a lightweight changelog. */
  log: string[];
  /** Populated when the fetch/compare failed; the shape is still returned so the UI can show why. */
  error?: string;
}

export interface ApplyStep { cmd: string; ok: boolean; out: string }
export interface ApplyResult {
  ok: boolean;
  steps: ApplyStep[];
  /** True when a restart was scheduled (a restart command was resolved). */
  restarting: boolean;
  error?: string;
}

function git(args: string[], timeout = 30_000): { ok: boolean; out: string; err: string } {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

let cache: UpdateStatus | null = null;
let inflight: Promise<UpdateStatus> | null = null;

/** Fetch + compare against the tracking branch; cached for CHECK_TTL_MS unless `force`. */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  if (!force && cache && Date.now() - cache.checkedAt < CHECK_TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = doCheck().finally(() => { inflight = null; });
  return inflight;
}

async function doCheck(): Promise<UpdateStatus> {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main';
  // The configured upstream if there is one, else assume origin/main (the deploy convention).
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).out || 'origin/main';
  const remote = upstream.split('/')[0] || 'origin';

  const fetched = git(['fetch', '--quiet', remote], 60_000);
  const dirty = git(['status', '--porcelain']).out.length > 0;

  let behind = 0;
  const rl = git(['rev-list', '--count', `HEAD..${upstream}`]);
  if (rl.ok) behind = parseInt(rl.out, 10) || 0;

  let latest = VERSION;
  const pkg = git(['show', `${upstream}:package.json`]);
  if (pkg.ok) { try { latest = (JSON.parse(pkg.out) as { version?: string }).version || VERSION; } catch { /* keep current */ } }

  let log: string[] = [];
  if (behind > 0) {
    const l = git(['log', '--pretty=%s', `HEAD..${upstream}`]);
    if (l.ok) log = l.out.split('\n').filter(Boolean).slice(0, 20);
  }

  cache = {
    current: VERSION,
    latest,
    behind,
    updateAvailable: behind > 0,
    branch,
    upstream,
    dirty,
    checkedAt: Date.now(),
    log,
    error: fetched.ok ? undefined : `git fetch failed: ${fetched.err || 'unknown error'}`,
  };
  return cache;
}

/** Resolve the shell command that restarts the service, or null if we can't (→ manual restart). */
function restartCommand(tenant: string): string | null {
  if (process.env.AOS_RESTART_CMD) return process.env.AOS_RESTART_CMD;
  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '';
    const label = process.env.AOS_LAUNCHD_LABEL || `com.agentos.${tenant}`;
    return `launchctl kickstart -k gui/${uid}/${label}`;
  }
  if (process.platform === 'linux') {
    const unit = process.env.AOS_SYSTEMD_UNIT || 'agent-os';
    return `sudo systemctl restart ${unit}`;
  }
  return null;
}

/** Pull + rebuild (server + web), then schedule the restart after the response is sent. */
export async function applyUpdate(tenant: string): Promise<ApplyResult> {
  const steps: ApplyStep[] = [];
  const run = (label: string, cmd: string, args: string[], cwd = REPO_ROOT): boolean => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    // Keep the tail — installs/builds are chatty and the UI only needs the outcome + last lines.
    steps.push({ cmd: label, ok: r.status === 0, out: out.slice(-4000) });
    return r.status === 0;
  };

  if (git(['status', '--porcelain']).out.length > 0)
    return { ok: false, steps, restarting: false, error: 'working tree has uncommitted changes — commit or stash on the box first' };

  if (!run('git pull --ff-only', 'git', ['pull', '--ff-only'])) return { ok: false, steps, restarting: false, error: 'git pull failed' };
  if (!run('npm install', 'npm', ['install', '--no-audit', '--no-fund'])) return { ok: false, steps, restarting: false, error: 'npm install failed' };
  if (!run('npm run build', 'npm', ['run', 'build'])) return { ok: false, steps, restarting: false, error: 'server build failed' };
  const web = path.join(REPO_ROOT, 'web');
  if (!run('npm install (web)', 'npm', ['install', '--no-audit', '--no-fund'], web)) return { ok: false, steps, restarting: false, error: 'web npm install failed' };
  if (!run('npm run build (web)', 'npm', ['run', 'build'], web)) return { ok: false, steps, restarting: false, error: 'web build failed' };

  cache = null; // the running version is about to change — force a fresh check after the bounce.
  const cmd = restartCommand(tenant);
  if (cmd) scheduleRestart(cmd);
  return { ok: true, steps, restarting: !!cmd };
}

/** Fire the restart shortly after (so the HTTP response flushes first); detached so it outlives us. */
function scheduleRestart(cmd: string): void {
  setTimeout(() => {
    try {
      const child = spawn('sh', ['-c', cmd], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
      child.unref();
    } catch { /* if the bounce can't spawn, the operator restarts by hand — the pull already landed */ }
  }, 1500);
}
