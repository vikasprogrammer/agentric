#!/usr/bin/env node
/* The OUTCOME vocabulary — what a finished run says came of it.
 *
 * The `report` tool's enum is success|failure|partial, but the loopback route stores whatever it is
 * handed (`String(b.outcome || 'success')`), so `completed`, `progressed` and `blocked` are all in the
 * live data. `src/edge/outcome.ts` folds them in as synonyms; the console mapped NONE of them, so a chain
 * node that had reported `completed` rendered `done` — identical to a run that never reported at all —
 * and `blocked`, a failure, rendered grey instead of red.
 *
 * This pins the write-side normalisation. The read-side mapping (VERDICT_OF/VERDICT_META in web/src) is
 * pure presentation and is verified by screenshot; what must not regress is that the DB stops
 * accumulating synonyms and that `report` closes the turn out properly.
 *
 * Isolated home; the session backend is stubbed. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-outcome-vocab-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
tm.backend.aliveNames = () => new Set();
tm.backend.kill = () => {};
tm.backend.capturePane = () => '';
tm.backend.hasClient = () => false;

// The row's `outcome` column is stamped by stampInsights (off the `session.reported` audit row), which
// runs inside listSessions — so drive that before reading, exactly as the console does.
const row = (id) => { tm.listSessions(); return aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id); };
let n = 0;
const mk = () => {
  const id = 'ses_out_' + (++n), now = Date.now();
  aos.db.prepare(`INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,secret,spawned_by,run_as,busy_since,created_at,updated_at)
    VALUES (?,?,?,?,?,'running',0,0,'s','m_a','m_a',?,?,?)`).run(id, 'agent-demo', 'provisional title', 'task', 'aos-' + id, now, now, now);
  return id;
};

console.log('\n\x1b[1m1) the synonyms agents actually write are normalised at the WRITE\x1b[0m');
for (const [given, want] of [['completed', 'success'], ['progressed', 'partial'], ['blocked', 'failure'], ['error', 'failure']]) {
  const id = mk();
  tm.report(id, 'agent-demo', given, 'did the thing');
  assert(row(id).outcome === want, `\`${given}\` → \`${want}\``, 'got ' + row(id).outcome);
}

console.log('\n\x1b[1m2) the canonical three pass straight through\x1b[0m');
for (const v of ['success', 'partial', 'failure']) {
  const id = mk();
  tm.report(id, 'agent-demo', v, 'did the thing');
  assert(row(id).outcome === v, `\`${v}\` is unchanged`);
}

console.log('\n\x1b[1m3) casing/whitespace normalise; an UNKNOWN word is kept verbatim\x1b[0m');
{
  const id = mk();
  tm.report(id, 'agent-demo', '  Completed ', 'x');
  assert(row(id).outcome === 'success', 'trimmed + lowercased before mapping', row(id).outcome);
}
{
  const id = mk();
  tm.report(id, 'agent-demo', 'deferred', 'x');
  assert(row(id).outcome === 'deferred', 'an unrecognised word survives — the agent\'s own account beats a guess');
}

console.log('\n\x1b[1m4) reporting closes the turn out — with OR without a usable summary\x1b[0m');
console.log('   (the with-summary branch renames the row, and used to skip the busy_since clear)');
{
  const id = mk();
  tm.report(id, 'agent-demo', 'success', 'Imported 1,204 rows and verified the totals.');
  const r = row(id);
  assert(r.status === 'done', 'status → done');
  assert(r.busy_since === null, 'busy_since cleared on the RENAMING branch');
  assert(r.title !== 'provisional title', 'and the run is retitled from its own summary');
}
{
  const id = mk();
  tm.report(id, 'agent-demo', 'success', '');
  const r = row(id);
  assert(r.status === 'done', 'status → done');
  assert(r.busy_since === null, 'busy_since cleared on the no-summary branch');
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(fail ? 1 : 0);
