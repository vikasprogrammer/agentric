#!/usr/bin/env node
/* CONNECTORS FOLDER — retention + the resumable lookup that read it on every console poll.
 *
 * Live globex, 2026-11-19: `<home>/connectors/` held 61k files (677 MB) for 11k sessions because nothing
 * but an explicit session DELETE ever removed a launch's files, and `resumableIds` read the whole folder on
 * every `/api/sessions/summary` (the console's 1.5s poll) — ~50ms a call, enough with eight tabs open to
 * keep `/health` from answering once the box was also CPU-starved. Pinned here:
 *   - the by-id (summary) path stats only the rows it returns, never reads the folder;
 *   - the full-list path reads the folder once and reuses it until the folder changes;
 *   - retention prunes ONLY ended + old + pane-less sessions, keeps `.log` (the run's record), honours the
 *     per-pass bound, and does nothing when liveness is unknown.
 * Isolated home; no tmux, no claude (the backend's liveness poll is stubbed). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-connectors-retention-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager, CONNECTOR_FILE_RETENTION_DAYS } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const CONN = aos.paths.connectors;
fs.mkdirSync(CONN, { recursive: true });

let alive = new Set();
tm.backend.aliveNames = () => alive;

const DAY = 86_400_000;
const OLD = Date.now() - (CONNECTOR_FILE_RETENTION_DAYS + 5) * DAY;
const RECENT = Date.now() - 2 * DAY;
const mkRun = (id, status, at) => aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?)`).run(id, 'engineer', id, 'task', 'aos-' + id, status, at, at);
const LAUNCH = ['mcp.json', 'company.md', 'task', 'env', 'stopped', 'log'];
const mkFiles = (id, exts = LAUNCH) => {
  for (const e of exts) fs.writeFileSync(path.join(CONN, `session-${id}.${e}`), 'x');
  fs.mkdirSync(path.join(CONN, `session-${id}.d`, 'bin'), { recursive: true });
};
const filesOf = (id) => fs.readdirSync(CONN).filter((f) => f.startsWith(`session-${id}.`)).sort();

mkRun('ses_olddone', 'done', OLD); mkFiles('ses_olddone');
mkRun('ses_oldstop', 'stopped', OLD); mkFiles('ses_oldstop');
mkRun('ses_oldcrash', 'crashed', OLD); mkFiles('ses_oldcrash');
mkRun('ses_recent', 'done', RECENT); mkFiles('ses_recent');
mkRun('ses_running', 'running', OLD); mkFiles('ses_running');
mkRun('ses_livepane', 'stopped', OLD); mkFiles('ses_livepane');
mkFiles('ses_norow');                                   // a deleted session's leftovers
for (const f of filesOf('ses_norow')) fs.utimesSync(path.join(CONN, f), OLD / 1000, OLD / 1000);
mkFiles('ses_norow_new');                               // a deleted session's leftovers, but recent

// ── resumableIds ──────────────────────────────────────────────────────────────────────────────────
{
  const realReaddir = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = function (p, ...rest) { if (path.resolve(String(p)) === path.resolve(CONN)) reads++; return realReaddir.call(fs, p, ...rest); };
  try {
    const byId = tm.listSessions(undefined, undefined, ['ses_recent', 'ses_running']);
    assert(reads === 0, 'the by-id (summary) path never reads the connectors folder', `reads=${reads}`);
    assert(byId.every((s) => s.resumable === true), 'by-id rows with a .env are resumable');
    const full1 = tm.listSessions();
    const full2 = tm.listSessions();
    assert(reads === 1, 'the full list reads the folder once and reuses it while nothing changed', `reads=${reads}`);
    assert(full1.length === full2.length && full1.find((s) => s.id === 'ses_olddone')?.resumable === true, 'full-list resumable is correct');
    fs.rmSync(path.join(CONN, 'session-ses_recent.env'));
    const full3 = tm.listSessions();
    assert(reads === 2, 'removing a file invalidates the memo', `reads=${reads}`);
    assert(full3.find((s) => s.id === 'ses_recent')?.resumable === false, 'a removed .env reads non-resumable straight away');
    fs.writeFileSync(path.join(CONN, 'session-ses_recent.env'), 'x');
  } finally { fs.readdirSync = realReaddir; }
}

// ── retention ─────────────────────────────────────────────────────────────────────────────────────
alive = new Set(['aos-ses_livepane']);
{
  alive = null;
  const r = tm.pruneConnectorFiles();
  assert(r.sessions === 0, 'liveness unknown → prunes nothing');
  alive = new Set(['aos-ses_livepane']);
}
{
  const r = tm.pruneConnectorFiles(Date.now(), 2);
  assert(r.sessions === 2, 'a pass is bounded by maxSessions', JSON.stringify(r));
  const r2 = tm.pruneConnectorFiles();
  assert(r.sessions + r2.sessions === 4, 'the rest drains on the next pass (3 old ended + 1 old orphan)', JSON.stringify([r, r2]));
  for (const id of ['ses_olddone', 'ses_oldstop', 'ses_oldcrash', 'ses_norow']) {
    assert(JSON.stringify(filesOf(id)) === JSON.stringify([`session-${id}.log`]), `${id}: everything but .log removed (incl. the .d dir)`, filesOf(id).join(','));
  }
  for (const id of ['ses_recent', 'ses_running', 'ses_livepane', 'ses_norow_new']) {
    assert(filesOf(id).length === LAUNCH.length + 1, `${id}: untouched`, filesOf(id).join(','));
  }
  assert(tm.pruneConnectorFiles().sessions === 0, 'a settled folder is a no-op pass');
  assert(tm.listSessions().find((s) => s.id === 'ses_olddone')?.resumable === false, 'a pruned session is no longer one-click resumable');
}

// ── sessionPaneAlive (the process janitor's oracle) ───────────────────────────────────────────────
assert(tm.sessionPaneAlive('ses_livepane') === true, 'pane alive → true');
assert(tm.sessionPaneAlive('ses_olddone') === false, 'pane gone → false');
assert(tm.sessionPaneAlive('ses_norow') === false, 'no row → checks aos-<id>');
alive = null;
assert(tm.sessionPaneAlive('ses_olddone') === null, 'liveness unknown → null (never a kill)');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
