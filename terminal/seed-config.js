#!/usr/bin/env node
/**
 * Seed the config file claude will actually read, so an unattended session never parks on a first-run
 * prompt. Called by claude-launch.sh before claude starts; also unit-tested (scripts/claude-config-seed-test.cjs).
 *
 * Claude keeps its UI/first-run state in `.claude.json` **inside `$CLAUDE_CONFIG_DIR`**, falling back to
 * the home root when that isn't set. Rotation sets `CLAUDE_CONFIG_DIR` per session (a pooled account is a
 * credential dir), which used to move that file out from under the launcher's seed: the seed kept writing
 * `~/.claude.json` while claude read the account's copy. A rotated session therefore met the whole
 * first-run gauntlet — theme picker, then the folder-trust dialog, then whatever upsell is current — and
 * an unattended TUI has nobody to answer it, so it sat there until the reaper. Live on globex,
 * 2026-08-04, minutes after the first credential-dir account went in.
 *
 * Three things make a config dir "already onboarded":
 *   1. `hasCompletedOnboarding` — the theme picker.
 *   2. `projects["<dir>"].hasTrustDialogAccepted` — "Do you trust the files in this folder?", per folder.
 *      (`--dangerously-skip-permissions` does NOT dodge this one; it only suppresses per-tool prompts.)
 *   3. Every "seen/dismissed" counter claude has invented — `fullscreenUpsellSeenCount`,
 *      `effortCalloutDismissed`, `remoteDialogSeen`, … The box's own `~/.claude.json` has accumulated
 *      dozens over months; a freshly-logged-in credential dir has none.
 *
 * (3) is why this GAP-FILLS from the home-root config rather than setting a known list of keys: that list
 * grows with every claude release, and a missed key is another hung session. Copying whatever the box has
 * already dismissed inherits future ones for free. Gap-fill only — a key the target already has always
 * wins, so the account's own identity (`oauthAccount`, `userID`, per-account caches) is never touched, and
 * `projects`/`mcpServers` are skipped as per-directory/server config rather than UI state.
 *
 * Idempotent (writes only when something actually changed — several sessions can launch at once),
 * atomic (temp + rename), 0600, and never throws: a failure here must not block a session.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Per-directory and server configuration — not first-run UI state, and not ours to copy between accounts. */
const SKIP_INHERIT = new Set(['projects', 'mcpServers']);

const readJson = (p) => {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }   // missing / empty / corrupt → start from nothing
};

/**
 * @param {{home?: string, configDir?: string, projectDir?: string}} o
 * @returns {{target: string, changed: boolean, inherited: number, trusted: string[]}}
 */
function seedClaudeConfig(o = {}) {
  const home = o.home || os.homedir();
  const configDir = o.configDir || '';
  const boxPath = path.join(home, '.claude.json');
  const target = configDir ? path.join(configDir, '.claude.json') : boxPath;
  const cfg = readJson(target);
  let changed = false;
  let inherited = 0;

  // A rotated session reads a DIFFERENT file from the box's: carry over everything the box has already
  // dismissed. Nothing to inherit when the target IS the box config (the un-rotated case).
  if (path.resolve(target) !== path.resolve(boxPath)) {
    for (const [k, v] of Object.entries(readJson(boxPath))) {
      if (SKIP_INHERIT.has(k) || k in cfg) continue;
      cfg[k] = v;
      inherited++;
      changed = true;
    }
  }

  if (cfg.hasCompletedOnboarding !== true) { cfg.hasCompletedOnboarding = true; changed = true; }

  // Trust is keyed by the path claude actually OPENS. A symlinked path (a macOS scratch home under
  // /var → /private/var) is resolved by claude before the lookup, so seed both spellings or the dialog
  // still fires on the real path.
  const trusted = [];
  if (o.projectDir) {
    cfg.projects = cfg.projects || {};
    const dirs = new Set([o.projectDir]);
    try { dirs.add(fs.realpathSync(o.projectDir)); } catch { /* not present yet → the given path is all we have */ }
    for (const dir of dirs) {
      const cur = cfg.projects[dir] || {};
      if (cur.hasTrustDialogAccepted === true) continue;
      cur.hasTrustDialogAccepted = true;
      cfg.projects[dir] = cur;
      trusted.push(dir);
      changed = true;
    }
  }

  if (changed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.aos-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);   // atomic replace
  }
  return { target, changed, inherited, trusted };
}

module.exports = { seedClaudeConfig };

if (require.main === module) {
  try {
    seedClaudeConfig({ configDir: process.env.CLAUDE_CONFIG_DIR, projectDir: process.argv[2] });
  } catch { /* never block a launch */ }
}
