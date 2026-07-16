/**
 * System dependencies — the native commands Agent OS needs on the box to run agent sessions.
 *
 * The Node process itself is zero-dependency, but a live instance shells out to a couple of native
 * tools that aren't Node built-ins: `tmux` (backs every persistent agent pane) and `ttyd` (serves the
 * in-browser terminal). `claude` (the agent runtime each session launches) and `git` (the self-update
 * path) round out the set. On a fresh box these are the classic "why won't a session start?" gaps, so
 * we make them checkable from Settings → System and installable via one shortcut.
 *
 * `checkDeps()` probes each binary (present? which path? what version?) — pure inspection, safe for any
 * member to read. `installDeps()` resolves the box's package manager (brew on macOS; apt/dnf/yum/pacman
 * on Linux) and installs the still-missing package-manager-installable deps, returning each step's log —
 * owner-gated at the route, same posture as the self-update apply. Deps with no package (i.e. `claude`,
 * installed via npm) are never auto-installed; we surface their manual hint instead.
 */
import { spawnSync } from 'child_process';

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
    hint: 'npm install -g @anthropic-ai/claude-code',
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
}

/** Resolve a binary's absolute path via `command -v` (portable across sh); '' when not found. */
function whichBin(bin: string): string {
  const r = spawnSync('sh', ['-c', `command -v ${bin} 2>/dev/null`], { encoding: 'utf8', timeout: 5000 });
  return (r.stdout || '').trim().split('\n')[0] || '';
}

/** Best-effort version string — first line of `<bin> <versionArg>` (stdout or stderr); undefined if none. */
function binVersion(bin: string, versionArg = '--version'): string | undefined {
  const r = spawnSync(bin, [versionArg], { encoding: 'utf8', timeout: 5000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0].trim();
  return out || undefined;
}

/** Probe every dependency: present? where? what version? Pure inspection — no side effects. */
export function checkDeps(): DepsReport {
  const deps: DepStatus[] = REQUIRED_DEPS.map((d) => {
    const path = whichBin(d.bin);
    return { ...d, installed: !!path, path: path || undefined, version: path ? binVersion(d.bin, d.versionArg) : undefined };
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
