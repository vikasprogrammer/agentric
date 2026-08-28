#!/usr/bin/env node
// Pins the one-command status line installer (scripts/install-statusline.sh) + the renderer's
// standalone lane (terminal/statusline.js).
//
// This script edits a REAL user's ~/.claude/settings.json on a machine we will never see — the file
// that also holds their hooks, permissions and MCP servers. So the properties worth a falsifier are
// less about pretty output and more about not destroying config:
//   1. an unrelated key (hooks) survives the patch
//   2. a pre-existing statusLine is snapshotted, and --uninstall puts it back verbatim
//   3. a re-run does NOT re-snapshot (which would record OUR line as "previous" and make uninstall
//      a no-op — the bug that turns a reversible install into a one-way door)
//   4. a fresh machine with no settings.json installs, and uninstall removes the key rather than
//      leaving a dangling one
//   5. the renderer runs with NO Agentric env: no agent id, no server call, no crash
// Runs entirely offline (--local copies from this checkout) and inside a temp dir.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'scripts', 'install-statusline.sh');
const RENDERER = path.join(ROOT, 'terminal', 'statusline.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-statusline-'));
const cfg = (name) => path.join(tmp, name);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

function run(dir, ...args) {
  const r = spawnSync('bash', [INSTALLER, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`installer ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

console.log('statusline installer');

// --- 1-3: a machine that already has a statusLine and hooks ------------------------------------
const A = cfg('existing');
fs.mkdirSync(A);
const RIVAL = { type: 'command', command: 'npx -y ccstatusline@latest', refreshInterval: 10 };
fs.writeFileSync(path.join(A, 'settings.json'), JSON.stringify({
  statusLine: RIVAL,
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
}, null, 2));

run(A, '--local');
let s = readJson(path.join(A, 'settings.json'));
check('renderer installed', fs.existsSync(path.join(A, 'agentric-statusline.js')));
check('statusLine points at the renderer', (s.statusLine.command || '').includes('agentric-statusline.js'), s.statusLine.command);
check('unrelated settings survive', s.hooks.Stop[0].hooks[0].command === 'echo hi');
check('backup written', fs.existsSync(path.join(A, 'settings.json.bak')));
check('previous statusLine snapshotted', JSON.stringify(readJson(path.join(A, '.agentric-statusline.prev.json'))) === JSON.stringify(RIVAL));

run(A, '--local'); // re-run
check('re-run keeps the ORIGINAL snapshot', JSON.stringify(readJson(path.join(A, '.agentric-statusline.prev.json'))) === JSON.stringify(RIVAL));

run(A, '--uninstall');
s = readJson(path.join(A, 'settings.json'));
check('uninstall restores the previous statusLine', JSON.stringify(s.statusLine) === JSON.stringify(RIVAL));
check('uninstall keeps unrelated settings', s.hooks.Stop[0].hooks[0].command === 'echo hi');
check('uninstall removes the renderer', !fs.existsSync(path.join(A, 'agentric-statusline.js')));

// --- 4: a fresh machine ------------------------------------------------------------------------
const B = cfg('fresh');
run(B, '--local');
s = readJson(path.join(B, 'settings.json'));
check('fresh install creates settings.json', s && (s.statusLine.command || '').includes('agentric-statusline.js'));
run(B, '--uninstall');
s = readJson(path.join(B, 'settings.json'));
check('fresh uninstall removes the key', s && s.statusLine === undefined);

// --- 5: the renderer, ungoverned ---------------------------------------------------------------
const payload = JSON.stringify({
  workspace: { current_dir: ROOT },
  model: { display_name: 'Opus 5' },
  context_window: { used_percentage: 37 },
  cost: { total_cost_usd: 0.42, total_lines_added: 12, total_lines_removed: 3 },
});
const env = { ...process.env };
for (const k of ['AOS_URL', 'SESSION', 'AOS_SECRET', 'AGENT', 'CLAUDE_MODEL', 'CLAUDE_EFFORT']) delete env[k];
const r = spawnSync('node', [RENDERER], { input: payload, env, encoding: 'utf8', timeout: 5000 });
const bar = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
check('renderer exits clean with no Agentric env', r.status === 0, r.stderr);
check('renders the native metrics', bar.includes('Opus 5') && bar.includes('37%') && bar.includes('+12'), bar);
check('no agent placeholder in a personal session', !bar.includes('◆'), bar);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall statusline installer checks passed');
