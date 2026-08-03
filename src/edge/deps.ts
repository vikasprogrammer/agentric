/**
 * System dependencies — the native commands Agent OS needs on the box to run agent sessions.
 *
 * The Node process itself is zero-dependency, but a live instance shells out to a couple of native
 * tools that aren't Node built-ins: `tmux` (backs every persistent agent pane) and `ttyd` (serves the
 * in-browser terminal). `claude` (the agent runtime each session launches) and `git` (the self-update
 * path) round out the set. On a fresh box these are the classic "why won't a session start?" gaps, so
 * we make them checkable from Settings → System and installable via one shortcut.
 *
 * `checkDeps()` probes each binary (present? which path? what version?) — pure inspection with no
 * network, safe for any member to read. `checkDepUpdates()` layers *freshness* on top for deps that name
 * an npm package: it asks the registry for `latest` and flags a stale install. That gap was real — a box
 * pinned to an old `claude` reported a green "All required dependencies are installed" while its runtime
 * predated the current model line, because presence was the only thing ever checked.
 *
 * `installDeps()` resolves the box's package manager (brew on macOS; apt/dnf/yum/pacman on Linux) and
 * installs the still-missing package-manager-installable deps; `updateNpmDep()` is the npm-side sibling
 * that upgrades one npm-installed dep in place. Both return each step's log and are owner-gated at the
 * route, same posture as the self-update apply.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { claudeBinCandidates, parseVersion, atLeastVersion } from './claude-cli';

export interface Dep {
  /** The binary as invoked on PATH. */
  bin: string;
  /** Human label for the UI. */
  label: string;
  /** Why Agent OS needs it. */
  purpose: string;
  /** A hard requirement (agent sessions won't run without it) vs. recommended. */
  required: boolean;
  /** Package name for the system package manager (brew/apt/…); omit for deps installed another way. */
  pkg?: string;
  /** Manual install hint, shown when there's no `pkg` (e.g. `claude` via npm) or the box has no manager. */
  hint?: string;
  /** Flag that prints the version — defaults to `--version`; tmux only understands `-V`. */
  versionArg?: string;
  /**
   * npm package this dep is installed from. When set, `checkDepUpdates()` compares the installed version
   * against the registry's `latest` and `updateNpmDep()` can upgrade it in place.
   */
  npmPkg?: string;
  /**
   * Extra candidate locations to try, in order, when the bare PATH lookup would miss — resolved lazily so
   * env + homedir are read at probe time. A launchd/systemd parent ships a minimal PATH without
   * `~/.local/bin`, so `claude` launches fine in a session yet `command -v claude` finds nothing; without
   * this the panel would report the runtime MISSING on a perfectly healthy box.
   */
  candidates?: () => string[];
}

/** The native tools a running instance shells out to. Order = display order. */
export const REQUIRED_DEPS: Dep[] = [
  {
    bin: 'tmux',
    label: 'tmux',
    purpose: 'Backs every agent session — each run lives in a persistent tmux pane.',
    required: true,
    pkg: 'tmux',
    versionArg: '-V',
  },
  {
    bin: 'ttyd',
    label: 'ttyd',
    purpose: 'Serves the in-browser terminal used to watch and take over a live session.',
    required: true,
    pkg: 'ttyd',
  },
  {
    bin: 'claude',
    label: 'Claude Code',
    purpose: 'The agent runtime each claude-code session launches.',
    required: true,
    hint: 'npm install -g @anthropic-ai/claude-code@latest',
    npmPkg: '@anthropic-ai/claude-code',
    candidates: claudeBinCandidates,
  },
  {
    bin: 'git',
    label: 'git',
    purpose: 'Powers self-update (fetch → fast-forward pull → rebuild) from Settings → System.',
    required: false,
    pkg: 'git',
  },
];

export interface DepStatus extends Dep {
  installed: boolean;
  /** Resolved absolute path on PATH, when installed. */
  path?: string;
  /** First line of `<bin> --version`, best-effort (some tools print to stderr / don't support it). */
  version?: string;
  /** True when the binary resolved only via a `candidates` fallback — i.e. it is NOT on the server's
   *  PATH. Sessions still launch (the launcher walks the same list), but it's worth surfacing. */
  offPath?: boolean;
  /** Registry `latest` for `npmPkg`, filled in by `checkDepUpdates()`. */
  latest?: string;
  /** True when `latest` is newer than the installed version. */
  updateAvailable?: boolean;
  /** Why the freshness probe couldn't answer (offline box, registry error) — never fatal. */
  updateError?: string;
}

export interface DepsReport {
  deps: DepStatus[];
  /** True when every `required` dep is present — sessions can run. */
  ok: boolean;
  /** Missing deps that a package manager could install (drives the "Install now" button). */
  installable: string[];
  /** The resolved package manager for this box, or null when none is available (→ manual hints only). */
  manager: PackageManager | null;
  /** The one-line shell command that installs the currently-missing installable deps, or null when
   *  nothing's missing / no manager. Shown copyable in the UI as the fallback to the button. */
  installCommand: string | null;
  /** The zero-dependency bootstrap shortcut (works before `npm run build`). Always shown as a hint. */
  shortcut: string;
  platform: string;
  /** Installed-but-stale npm deps (drives the per-row "Update" button). Empty until `checkDepUpdates()`. */
  outdated: string[];
  /** When the freshness probe last ran, or 0 if it hasn't. */
  updatesCheckedAt: number;
}

/** Resolve a binary's absolute path via `command -v` (portable across sh); '' when not found. */
function whichBin(bin: string): string {
  const r = spawnSync('sh', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8', timeout: 5000 });
  return (r.stdout || '').trim().split('\n')[0] || '';
}

/** True when `p` names an existing executable file. */
function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one dep to an absolute path, walking `candidates()` IN ORDER — the same order the launcher
 * uses. Order is the whole point: `claude-cli.ts` prefers `$CLAUDE_BIN` over PATH, so resolving PATH
 * first here would report the version of a binary sessions never actually run. A candidate naming a
 * path is taken when it's executable; a bare name goes through PATH.
 *
 * `offPath` means a plain `command -v <bin>` finds nothing — the binary is reachable only via a
 * fallback. Sessions still launch (the launcher checks the same list), but it's worth showing.
 */
function resolveDep(d: Dep): { path: string; offPath: boolean } {
  const onPath = whichBin(d.bin);
  for (const c of d.candidates?.() ?? [d.bin]) {
    const p = c === d.bin ? onPath : c.includes('/') ? (isExecutable(c) ? c : '') : whichBin(c);
    if (p) return { path: p, offPath: !onPath };
  }
  return { path: '', offPath: false };
}

/** Best-effort version string — first line of `<bin> <versionArg>` (stdout or stderr); undefined if none. */
function binVersion(bin: string, versionArg = '--version'): string | undefined {
  const r = spawnSync(bin, [versionArg], { encoding: 'utf8', timeout: 5000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0].trim();
  return out || undefined;
}

/** Probe every dependency: present? where? what version? Pure inspection — no side effects, no network. */
export function checkDeps(): DepsReport {
  const deps: DepStatus[] = REQUIRED_DEPS.map((d) => {
    const { path, offPath } = resolveDep(d);
    // Version-probe the RESOLVED path, not the bare name — otherwise an off-PATH binary reports no version.
    return {
      ...d,
      installed: !!path,
      path: path || undefined,
      offPath: path ? offPath : undefined,
      version: path ? binVersion(path, d.versionArg) : undefined,
    };
  });
  const ok = deps.every((d) => !d.required || d.installed);
  const manager = resolveManager();
  // A missing dep is "installable" only if it names a package AND we have a manager to install it with.
  const installable = deps.filter((d) => !d.installed && d.pkg && manager).map((d) => d.bin);
  const pkgs = deps.filter((d) => installable.includes(d.bin)).map((d) => d.pkg!) as string[];
  return {
    deps,
    ok,
    installable,
    manager,
    installCommand: manager && pkgs.length ? installCommandFor(manager, pkgs) : null,
    shortcut: 'npm run install-deps',
    platform: process.platform,
    outdated: [],
    updatesCheckedAt: 0,
  };
}

/** How long a registry `latest` lookup is reused before we ask again. Mirrors the self-update check. */
const FRESHNESS_TTL_MS = 60 * 60_000;

const latestCache = new Map<string, { version: string; at: number }>();

/**
 * Ask the npm registry for a package's `latest` version. Uses the abbreviated `/latest` endpoint (a few
 * hundred bytes, not the full packument) via the global `fetch`, so this stays zero-dependency and never
 * shells out to `npm` — which may not even be on a systemd unit's PATH. Cached for `FRESHNESS_TTL_MS`.
 */
async function npmLatest(pkg: string, force = false): Promise<string> {
  const hit = latestCache.get(pkg);
  if (!force && hit && Date.now() - hit.at < FRESHNESS_TTL_MS) return hit.version;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}/latest`, {
      signal: ctrl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    const version = ((await res.json()) as { version?: string }).version;
    if (!version) throw new Error('registry returned no version');
    latestCache.set(pkg, { version, at: Date.now() });
    return version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Layer freshness onto a report: for every installed dep that names an npm package, compare the probed
 * version against the registry's `latest`. Network failures degrade to a per-dep `updateError` — an
 * offline box still gets its full presence report, it just can't claim anything about staleness.
 */
export async function checkDepUpdates(report: DepsReport, force = false): Promise<DepsReport> {
  const deps = await Promise.all(report.deps.map(async (d): Promise<DepStatus> => {
    if (!d.npmPkg || !d.installed) return d;
    const installed = parseVersion(d.version);
    if (!installed) return { ...d, updateError: 'could not parse the installed version' };
    try {
      const latest = await npmLatest(d.npmPkg, force);
      const want = parseVersion(latest);
      // `atLeastVersion(installed, want)` false ⇒ installed is behind. An unparseable `latest` is a
      // registry oddity, not a stale install — say nothing rather than cry wolf.
      return want
        ? { ...d, latest, updateAvailable: !atLeastVersion(installed, want) }
        : { ...d, updateError: 'could not parse the published version' };
    } catch (e) {
      return { ...d, updateError: e instanceof Error ? e.message : String(e) };
    }
  }));
  return {
    ...report,
    deps,
    outdated: deps.filter((d) => d.updateAvailable).map((d) => d.bin),
    updatesCheckedAt: Date.now(),
  };
}

export type PackageManager = 'brew' | 'apt-get' | 'dnf' | 'yum' | 'pacman' | 'zypper';

/** Detect the box's package manager (first present wins; brew preferred on macOS). */
export function resolveManager(): PackageManager | null {
  const order: PackageManager[] = process.platform === 'darwin'
    ? ['brew']
    : ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'brew'];
  for (const m of order) if (whichBin(m)) return m;
  return null;
}

/** The full install command for a manager + package list. Linux managers need root; brew must NOT. */
export function installCommandFor(manager: PackageManager, pkgs: string[]): string {
  const list = pkgs.join(' ');
  switch (manager) {
    case 'brew': return `brew install ${list}`;
    case 'apt-get': return `sudo apt-get update && sudo apt-get install -y ${list}`;
    case 'dnf': return `sudo dnf install -y ${list}`;
    case 'yum': return `sudo yum install -y ${list}`;
    case 'pacman': return `sudo pacman -S --noconfirm ${list}`;
    case 'zypper': return `sudo zypper install -y ${list}`;
  }
}

export interface InstallStep { cmd: string; ok: boolean; out: string }
export interface InstallResult {
  ok: boolean;
  steps: InstallStep[];
  /** The dependency report after the install attempt, so the UI can refresh in one round-trip. */
  report: DepsReport;
  error?: string;
}

/**
 * Install the currently-missing, package-manager-installable deps and re-check. Owner-gated at the route.
 * We run the resolved manager directly (not via `sh -c`) so a hung network can't wedge a shell; brew is
 * invoked without sudo (it refuses to run as root), the Linux managers with it.
 */
export function installDeps(): InstallResult {
  const before = checkDeps();
  if (before.ok && !before.installable.length)
    return { ok: true, steps: [], report: before, error: undefined };
  const manager = before.manager;
  if (!manager)
    return { ok: false, steps: [], report: before, error: 'no supported package manager found (brew/apt/dnf/yum/pacman/zypper) — install the missing tools by hand' };
  const pkgs = before.deps.filter((d) => before.installable.includes(d.bin)).map((d) => d.pkg!);
  if (!pkgs.length)
    return { ok: false, steps: [], report: before, error: 'nothing installable is missing (remaining gaps need a manual install — see each dependency\'s hint)' };

  const steps: InstallStep[] = [];
  const run = (label: string, cmd: string, args: string[]): boolean => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    steps.push({ cmd: label, ok: r.status === 0, out: out.slice(-4000) });
    return r.status === 0;
  };

  let ok = true;
  if (manager === 'brew') {
    ok = run(`brew install ${pkgs.join(' ')}`, 'brew', ['install', ...pkgs]);
  } else if (manager === 'apt-get') {
    // apt needs its index fresh before an install can resolve the packages.
    run('sudo apt-get update', 'sudo', ['apt-get', 'update']);
    ok = run(`sudo apt-get install -y ${pkgs.join(' ')}`, 'sudo', ['apt-get', 'install', '-y', ...pkgs]);
  } else if (manager === 'dnf' || manager === 'yum' || manager === 'zypper') {
    ok = run(`sudo ${manager} install -y ${pkgs.join(' ')}`, 'sudo', [manager, 'install', '-y', ...pkgs]);
  } else if (manager === 'pacman') {
    ok = run(`sudo pacman -S --noconfirm ${pkgs.join(' ')}`, 'sudo', ['pacman', '-S', '--noconfirm', ...pkgs]);
  }

  const report = checkDeps();
  return { ok: ok && report.ok, steps, report, error: ok ? undefined : 'one or more install steps failed — see the logs' };
}

/**
 * Resolve the `npm` that owns a globally-installed binary. Prefer the one sitting beside it — on an
 * nvm-managed box the service PATH may reach `claude` without reaching `npm`, and a *different* npm would
 * install into a different node prefix, silently leaving the running binary untouched. Falls back to PATH.
 */
function npmFor(depPath?: string): string {
  if (depPath) {
    const sibling = path.join(path.dirname(depPath), 'npm');
    try {
      fs.accessSync(sibling, fs.constants.X_OK);
      return sibling;
    } catch { /* no npm beside it — fall through to PATH */ }
  }
  return whichBin('npm');
}

/**
 * Upgrade one npm-installed dependency in place (`npm install -g <pkg>@latest`) and re-check. Owner-gated
 * at the route. Deliberately never sudo: `sudo npm -g` is a well-known footgun (it leaves root-owned files
 * in the prefix), so a permissions failure surfaces the raw error and the manual hint instead.
 *
 * Note for callers/UI: replacing the binary does NOT affect sessions already running — on Linux a live
 * process keeps its open inode, so panes launched before the upgrade keep the old version until restarted.
 */
export async function updateNpmDep(bin: string): Promise<InstallResult> {
  const before = checkDeps();
  const dep = before.deps.find((d) => d.bin === bin);
  const fail = async (error: string): Promise<InstallResult> => ({ ok: false, steps: [], report: await checkDepUpdates(before), error });

  if (!dep) return fail(`unknown dependency '${bin}'`);
  if (!dep.npmPkg) return fail(`'${bin}' is not installed from npm — update it by hand (${dep.hint || 'see its install hint'})`);
  if (!dep.installed) return fail(`'${bin}' isn't installed yet — install it first`);

  const npm = npmFor(dep.path);
  if (!npm) return fail(`no \`npm\` found on this box — update by hand: ${dep.hint || `npm install -g ${dep.npmPkg}@latest`}`);

  const spec = `${dep.npmPkg}@latest`;
  const r = spawnSync(npm, ['install', '-g', spec], { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const ok = r.status === 0;
  const steps: InstallStep[] = [{ cmd: `${npm} install -g ${spec}`, ok, out: out.slice(-4000) }];

  // The version probe is memoised per binary path, so force a fresh registry read to reflect the upgrade.
  const report = await checkDepUpdates(checkDeps(), true);
  const still = report.deps.find((d) => d.bin === bin);
  return {
    ok: ok && !still?.updateAvailable,
    steps,
    report,
    error: ok
      ? (still?.updateAvailable ? 'the install reported success but the binary still looks stale — check the log' : undefined)
      : (/EACCES|permission denied/i.test(out)
        ? `npm couldn't write to its global prefix — run it by hand as the owning user: ${dep.hint || `npm install -g ${spec}`}`
        : 'the update step failed — see the log'),
  };
}
