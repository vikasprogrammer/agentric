#!/usr/bin/env node
/* Cron supersede test — an INTERACTIVE cron automation keeps its pane after the run finishes, and the
 * scheduler's pile-up guard used to read that idle pane as "still running" and skip every later occurrence
 * until someone closed the tab. Now the next occurrence closes the previous run when nobody is using it,
 * and skips (audited once per occurrence) only when it really is in use: attached, claimed, mid-turn,
 * blocked on a person, an unattended run, or attachment can't be polled. Isolated home; the session backend
 * and createSession are stubbed so no tmux/claude runs. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-supersede-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;
delete process.env.AOS_MAX_CONCURRENT_SESSIONS;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));
const { Automations } = require(path.join(ROOT, 'dist/edge/automations.js'));

const aos = loadAgentOS();
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));
const autos = new Automations(aos, tm);

// ── stubs: a pane set stands in for tmux; createSession inserts a row instead of spawning ──
const panes = new Set();
const attached = new Map(); // tmux → true | false | null (null = can't poll)
const killed = [];
tm.backend.aliveNames = () => new Set(panes);
tm.backend.hasClient = (_s, t) => (attached.has(t) ? attached.get(t) : false);
tm.backend.kill = (_s, t) => { killed.push(t); panes.delete(t); };
let seq = 0;
tm.createSession = (agent, title, task, spawnedBy, headless) => {
  const id = `s${++seq}`, tmux = `aos-${id}`, now = Date.now();
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,resident,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,0,?,?,?)")
    .run(id, agent, title, task, tmux, headless ? 1 : 0, spawnedBy, now, now);
  panes.add(tmux);
  return { id, tmux };
};

const AID = 'au_weekly';
aos.db.prepare("INSERT INTO automations (id, agent_id, name, type, mode, schedule, task, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
  .run(AID, 'seo', 'Weekly SEO loop', 'cron', 'interactive', '30 3 * * 1', 'Run the loop.', 1, Date.now() - 30 * 86400000);
const auto = () => autos.list().find((a) => a.id === AID);
const row = (id) => aos.db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id);
const audits = (type) => aos.db.prepare('SELECT data FROM audit_events WHERE type = ?').all(type).map((r) => JSON.parse(r.data));

// A finished-but-open previous run: turn started, then a turn-end landed after it.
const prevRun = (patch = {}) => {
  const first = autos.fire(auto(), { guard: false });
  const t = Date.now() - 3600_000;
  aos.db.prepare('UPDATE term_sessions SET busy_since = ?, last_activity = ? WHERE id = ?').run(t, t + 60_000, first.sessionId);
  for (const [k, v] of Object.entries(patch)) aos.db.prepare(`UPDATE term_sessions SET ${k} = ? WHERE id = ?`).run(v, first.sessionId);
  return first.sessionId;
};

console.log('\n\x1b[1m1) idle, detached previous run → superseded, the cron fires\x1b[0m');
{
  const prev = prevRun();
  const r = autos.fire(auto(), { guard: true });
  assert(r.ok === true, 'guarded fire succeeds', JSON.stringify(r));
  assert(killed.includes(`aos-${prev}`), 'previous pane killed');
  assert(row(prev).status === 'done', `previous row ended (status ${row(prev).status})`);
  assert(auto().lastSessionId === r.sessionId, 'automation now points at the new run');
  assert(audits('automation.superseded').some((d) => d.previous === prev), 'automation.superseded audited');
  assert(aos.db.prepare("SELECT 1 FROM audit_events WHERE type='session.reaped' AND run_id=? AND data LIKE '%superseded%'").get(prev), 'session.reaped reason=superseded');
}

const skipCase = (name, setup, want) => {
  const prev = prevRun(setup.patch);
  setup.after && setup.after(prev);
  const before = killed.length;
  const r = autos.fire(auto(), { guard: true });
  assert(r.ok === false && r.reason.includes(`(${want})`), `${name} → skipped (${want})`, JSON.stringify(r));
  assert(killed.length === before && panes.has(`aos-${prev}`), `${name} → previous pane untouched`);
  panes.delete(`aos-${prev}`); // clear the stage for the next case
};

console.log('\n\x1b[1m2) in use → keeps the skip\x1b[0m');
skipCase('attached', { after: (id) => attached.set(`aos-${id}`, true) }, 'attached');
skipCase('attachment unknown (null)', { after: (id) => attached.set(`aos-${id}`, null) }, 'attached');
skipCase('claimed', { patch: { claimed_by: 'm1' } }, 'claimed');
skipCase('mid-turn', { patch: { busy_since: Date.now() - 60_000, last_activity: Date.now() - 120_000 } }, 'working');
skipCase('blocked on a question', {
  after: (id) => aos.db.prepare("INSERT INTO questions (id,run_id,tenant,agent,prompt,status,created_at) VALUES (?,?,?,'seo','RFQ?','pending',?)").run(`q_${id}`, id, 'testco', Date.now()),
}, 'blocked');
skipCase('unattended (headless) run still live', { patch: { headless: 1 } }, 'unattended');

console.log('\n\x1b[1m3) previous pane already gone → fires without a supersede\x1b[0m');
{
  const prev = prevRun();
  panes.delete(`aos-${prev}`);
  const n = audits('automation.superseded').length;
  const r = autos.fire(auto(), { guard: true });
  assert(r.ok === true, 'fires');
  assert(audits('automation.superseded').length === n, 'no supersede audited');
}

console.log('\n\x1b[1m4) tick() audits a skip once per occurrence, not once per tick\x1b[0m');
{
  const prev = prevRun();
  attached.set(`aos-${prev}`, true);
  const monday = new Date(2026, 9, 5, 3, 30, 0, 0).getTime(); // a Monday 03:30 local
  aos.db.prepare('UPDATE automations SET last_fired_at = ? WHERE id = ?').run(monday - 7 * 86400000, AID);
  const n = audits('automation.skipped').length;
  autos.tick(new Date(monday));
  autos.tick(new Date(monday + 60_000));
  autos.tick(new Date(monday + 120_000));
  const skips = audits('automation.skipped').slice(n);
  assert(skips.length === 1, `one automation.skipped for three ticks (got ${skips.length})`);
  assert(skips[0] && skips[0].reason.includes('attached'), 'skip reason names why');
  attached.set(`aos-${prev}`, false);
  autos.tick(new Date(monday + 180_000));
  assert(auto().lastSessionId !== prev, 'once detached, the next tick inside the catch-up window supersedes and fires');
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}CRON SUPERSEDE: ${pass}/${pass + fail} passed\x1b[0m`);
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
