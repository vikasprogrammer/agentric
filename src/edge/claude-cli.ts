/**
 * Feature-detection for the installed `claude` CLI, probed once via `claude --version` and cached.
 * Older binaries lack newer slash commands (`/goal`, `/reload-skills`) and would treat a leading
 * `/command` as literal text, so callers gate on these before emitting one.
 *
 * Resolves the binary the SAME way `terminal/claude-launch.sh` does: a launchd/systemd parent ships a
 * minimal PATH without `~/.local/bin`, so a bare `claude` lookup would fail in prod even though sessions
 * launch fine — try `$CLAUDE_BIN`, then PATH, then the documented `~/.local/bin/claude`.
 */
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

let cachedVersion: number[] | null | undefined;

/** The installed `claude` version as `[major, minor, patch]`, or null if no binary resolves. Cached. */
export function claudeVersion(): number[] | null {
  if (cachedVersion !== undefined) return cachedVersion;
  const candidates = [process.env.CLAUDE_BIN, 'claude', path.join(os.homedir(), '.local/bin/claude')].filter(Boolean) as string[];
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
      if (m) { cachedVersion = [+m[1], +m[2], +m[3]]; return cachedVersion; }
    } catch {
      /* try the next candidate location */
    }
  }
  cachedVersion = null; // no `claude` resolvable (tests/demo)
  return cachedVersion;
}

/** True when `v` (a `[maj,min,patch]`) is ≥ `min`. */
export function atLeastVersion(v: number[], min: number[]): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** Whether the installed `claude` supports the `/goal` slash command (v2.1.139+). */
export function claudeSupportsGoal(): boolean {
  const v = claudeVersion();
  return v ? atLeastVersion(v, [2, 1, 139]) : false;
}

/** Whether the installed `claude` supports `/reload-skills` (v2.1.152+) — used for same-session skill
 *  delivery: after a skill is materialised into a live session's watched `.claude/skills`, we inject
 *  `/reload-skills` to force a re-scan + re-surface descriptions. On an older binary we skip the inject
 *  (the file-watcher still exposes the new skill as `/name` on the next turn). */
export function claudeSupportsReloadSkills(): boolean {
  const v = claudeVersion();
  return v ? atLeastVersion(v, [2, 1, 152]) : false;
}
