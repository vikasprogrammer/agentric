/**
 * Runtime presence + install (Settings → Runtimes).
 *
 * A runtime is only usable if its CLI is actually on this box's PATH. Switching an agent to a
 * runtime the box does not have produced a session that launched, printed "the 'x' CLI is not on
 * PATH" and parked — a dead end the operator could only fix by ssh-ing in. So the console reports
 * presence up front and can install a missing runtime itself.
 *
 * Safety notes, because this runs a package manager on the host:
 *  - The argv comes from {@link CODING_RUNTIMES}[id].install — a compile-time constant. The only
 *    caller-supplied value is the runtime ID, which is validated against that same table, so no
 *    caller input ever reaches the command line.
 *  - Spawned WITHOUT a shell (`shell: false`), so nothing is word-split, globbed or expanded.
 *  - Owner-gated at the route and audited (`runtime.install.*`) — installing a global package is a
 *    real, persistent change to the host, not a per-session effect.
 */
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CODING_RUNTIMES, CodingRuntimeId, RuntimeId, isCodingRuntime } from '../types';

export interface RuntimePresence {
  id: CodingRuntimeId;
  label: string;
  bin: string;
  /** Is the CLI resolvable on PATH right now? */
  installed: boolean;
  /** `<bin> --version`, best-effort and trimmed to one line; undefined when not installed. */
  version?: string;
  /** The command the console offers to run, for display. */
  install: string;
}

/** The PATH a launched session gets (see the launch scripts) — probe with the SAME one, or the
 *  console reports "missing" for a CLI the agent would in fact find, and vice versa. */
function probePath(): string {
  return [`${installPrefix()}/bin`, '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '']
    .filter(Boolean).join(':');
}

/**
 * Where a console-driven install puts the CLI.
 *
 * NOT npm's own global prefix. On the common NodeSource/apt layout that is `/usr`, which the server
 * cannot write: it runs as a non-root user, usually under `ProtectSystem=strict`, so `npm install -g`
 * dies with `ENOENT … mkdir '/usr/lib/node_modules/<pkg>'` and the Install button is simply broken on
 * every such box (seen live on a tenant box, 2026-08-25).
 *
 * `~/.local` is writable by the service user, is already inside the hardened unit's
 * `ReadWritePaths=/home/<svc>`, and — the part that makes it correct rather than merely convenient —
 * `~/.local/bin` is the FIRST entry of both {@link probePath} and the PATH every launch script
 * exports. So a CLI installed here is the one the probe reports AND the one a session actually runs.
 */
function installPrefix(): string {
  return join(process.env.HOME || '/tmp', '.local');
}

/** Resolve `bin` against a PATH string the way execvp does — first directory holding an executable
 *  file of that name wins. Done in-process on purpose: shelling out to `command -v` needs
 *  `shell: true`, which Node now warns about (DEP0190) on every call, and spawning a shell to answer
 *  "does this file exist" is a process per probe on a page the console loads often. */
function which(bin: string, path: string): boolean {
  for (const dir of path.split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch (_) { /* not here — keep looking */ }
  }
  return false;
}

/** Is `bin` on PATH, and at what version? Never throws. */
function probe(bin: string): { installed: boolean; version?: string } {
  const path = probePath();
  const env = { ...process.env, PATH: path };
  if (!which(bin, path)) return { installed: false };
  const v = spawnSync(bin, ['--version'], { env, timeout: 10000, encoding: 'utf8' });
  const line = String(v.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  return { installed: true, version: line || undefined };
}

/** Presence of every declared coding runtime, for `GET /api/runtimes` and the setup wizard. */
export function runtimePresence(): RuntimePresence[] {
  return Object.values(CODING_RUNTIMES).map((spec) => ({
    id: spec.id,
    label: spec.label,
    bin: spec.bin,
    install: spec.install.join(' '),
    ...probe(spec.bin),
  }));
}

export interface InstallResult {
  ok: boolean;
  /** Present on success — the version the box now reports. */
  version?: string;
  /** Present on failure — the tail of the installer's output, for the console to show. */
  error?: string;
}

/**
 * Install a runtime's CLI globally. Resolves when the installer exits; re-probes so the caller
 * reports the version that is actually on PATH rather than assuming success.
 */
export function installRuntime(id: string, timeoutMs = 300_000): Promise<InstallResult> {
  if (!isCodingRuntime(id as RuntimeId)) return Promise.resolve({ ok: false, error: `unknown runtime: ${id}` });
  const spec = CODING_RUNTIMES[id as CodingRuntimeId];
  const [cmd, ...args] = spec.install;
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: InstallResult) => { if (!done) { done = true; resolve(r); } };
    const prefix = installPrefix();
    // npm reads every flag from `npm_config_*` too, so the prefix rides the ENV rather than being
    // spliced into a constant argv — one mechanism that works for any npm-shaped install command.
    try { mkdirSync(join(prefix, 'bin'), { recursive: true }); } catch (_) { /* npm will report it */ }
    const child = spawn(cmd, args, {
      env: { ...process.env, PATH: probePath(), npm_config_prefix: prefix },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, error: `install timed out after ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
    // Keep only the tail: an npm install can emit megabytes, and all the console needs is the error.
    const collect = (b: Buffer) => { out = (out + b.toString()).slice(-4000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      // Trust the PROBE, not the exit code: npm can exit 0 while the shim lands somewhere off PATH
      // (a prefix the service user can't see), which would otherwise report a success the next
      // session immediately contradicts.
      const after = probe(spec.bin);
      if (after.installed) finish({ ok: true, version: after.version });
      else finish({ ok: false, error: out.trim() || `${spec.bin} is still not on PATH after \`${spec.install.join(' ')}\` (prefix ${prefix})` });
    });
  });
}
