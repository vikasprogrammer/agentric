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

/**
 * Candidate locations for the `claude` binary, in resolution order — `$CLAUDE_BIN`, then a bare PATH
 * lookup, then the documented `~/.local/bin/claude`. Resolved lazily (env + homedir are read per call)
 * and shared with `src/edge/deps.ts`, so the Settings → System probe and the launcher agree on which
 * binary is "installed" instead of drifting apart.
 */
export function claudeBinCandidates(): string[] {
  return [process.env.CLAUDE_BIN, 'claude', path.join(os.homedir(), '.local/bin/claude')].filter(Boolean) as string[];
}

/** The installed `claude` version as `[major, minor, patch]`, or null if no binary resolves. Cached. */
export function claudeVersion(): number[] | null {
  if (cachedVersion !== undefined) return cachedVersion;
  for (const bin of claudeBinCandidates()) {
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

/** First `x.y.z` in a version string as `[maj,min,patch]`, or null — tolerates trailing noise like
 *  `2.1.220 (Claude Code)`. Shared with the dependency-freshness probe. */
export function parseVersion(s: string | undefined): number[] | null {
  const m = (s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
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

/** The `claude` CLI rejects a `/goal` condition longer than this many characters
 *  ("Goal condition is limited to 4000 characters"). Callers must not emit a `/goal`
 *  above it — fall back to embedding the criteria in the prompt body instead. */
export const GOAL_MAX_CHARS = 4000;

/** Whether the installed `claude` supports `/reload-skills` (v2.1.152+) — used for same-session skill
 *  delivery: after a skill is materialised into a live session's watched `.claude/skills`, we inject
 *  `/reload-skills` to force a re-scan + re-surface descriptions. On an older binary we skip the inject
 *  (the file-watcher still exposes the new skill as `/name` on the next turn). */
export function claudeSupportsReloadSkills(): boolean {
  const v = claudeVersion();
  return v ? atLeastVersion(v, [2, 1, 152]) : false;
}
