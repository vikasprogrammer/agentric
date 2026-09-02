#!/usr/bin/env node
/* Session INSIGHTS stamping — the governance fingerprint, verdict, tuning, human-wait and deliverable
 * counts the sessions list carries per row (TerminalManager.stampInsights, surfaced by listSessions).
 *
 * The stamp used to fire SIX point queries per row it touched, and a LIVE row re-stamps on every poll —
 * so the 1.5 s summary poll paid 6 × (live rows) queries forever, and a first list over an unstamped
 * history paid 6 × (rows). It is now the same six lookups BATCHED with `run_id IN (…)` + GROUP BY,
 * chunked at 400. This pins the behaviour that must survive that:
 *   - every counter, the verdict, the tuning, the human-wait and the artifact count land on the right run;
 *   - the latest report wins when a resumed run reported twice;
 *   - only CLOSED approval/question waits count, and spans pair by approvalId;
 *   - a finished run that never reported stamps `unknown` (so it isn't re-derived forever);
 *   - a TERMINAL row is persisted (and then answered from the row, not the audit stream);
 *   - a LIVE row is recomputed and never frozen onto the row;
 *   - the chunking is exhaustive — 450 unstamped rows in one call all come back stamped.
 * Isolated home; no tmux or claude needed. */
const fs = require('fs');
const os_ = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os_.tmpdir(), 'aos-stamp-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { TerminalManager } = require(path.join(ROOT, 'dist/terminal.js'));

const aos = loadAgentOS();
const db = aos.db;
const tm = new TerminalManager(aos, 'http://127.0.0.1:0', path.join(HOME, 'tmux.sock'));

const { member } = aos.team.invite({ email: 'owner@testco.dev', role: 'owner' });
db.prepare("UPDATE members SET status='active' WHERE id=?").run(member.id);
const owner = aos.team.getMember(member.id);

const T0 = Date.now() - 3_600_000;
let n = 0;
const mkRun = (o = {}) => {
  const id = 'ts_' + (++n);
  db.prepare(`INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, run_as, created_at, updated_at)
              VALUES (?, 'engineer', 't', 'x', ?, ?, ?, ?, ?, ?)`)
    .run(id, 'aos-' + id, o.status ?? 'done', owner.id, owner.id, o.createdAt ?? T0 + n * 1000, o.createdAt ?? T0 + n * 1000);
  return id;
};
const ev = (runId, type, data, ts) => db
  .prepare('INSERT INTO audit_events (ts, run_id, tenant, principal, type, data) VALUES (?, ?, ?, ?, ?, ?)')
  .run(ts ?? Date.now(), runId, 'testco', 'tester', type, JSON.stringify(data ?? {}));
const rowOf = (id) => db.prepare('SELECT * FROM term_sessions WHERE id = ?').get(id);
const listed = (id) => tm.listSessions(owner, 240).find((s) => s.id === id);

// ── a finished run with the full spread ───────────────────────────────────────
const done = mkRun();
for (let i = 0; i < 5; i++) ev(done, 'gate.decision', { decision: { effect: 'allow' } });
ev(done, 'gate.decision', { decision: { effect: 'deny', reason: 'never' } });
ev(done, 'approval.requested', { approvalId: 'ap1' }, 1_000);
ev(done, 'approval.resolved', { approvalId: 'ap1', approved: true }, 4_000);   // 3s wait
ev(done, 'approval.requested', { approvalId: 'ap2' }, 5_000);                  // never resolved
ev(done, 'approval.resolved', { approvalId: 'ap3', approved: false }, 6_000);  // rejected, unpaired
ev(done, 'session.error', {});
ev(done, 'session.tuning', { model: 'opus', effort: 'high', outputStyle: 'Concise' });
ev(done, 'session.reported', { outcome: 'failure', summary: 'first try' }, 10_000);
ev(done, 'session.reported', { outcome: 'success', summary: '  shipped it  ' }, 20_000);
db.prepare("INSERT INTO questions (id, run_id, tenant, agent, prompt, status, created_at, answered_at) VALUES ('q1', ?, 'testco', 'engineer', 'p', 'answered', 100, 2100)").run(done);
db.prepare("INSERT INTO questions (id, run_id, tenant, agent, prompt, status, created_at) VALUES ('q2', ?, 'testco', 'engineer', 'p', 'pending', 100)").run(done);
db.prepare(`INSERT INTO artifacts (id, session_id, agent, kind, title, filename, rel_path, mime, bytes, created_at)
            VALUES ('ar1', ?, 'engineer', 'file', 'a', 'a.md', 'ar1/a.md', 'text/markdown', 1, 1)`).run(done);

const s = listed(done);
console.log('\na finished run');
assert(s.insights && s.insights.actions === 6, 'gov actions = every gate.decision', JSON.stringify(s.insights));
assert(s.insights.denied === 2, 'denied = policy denies + human rejections', String(s.insights.denied));
assert(s.insights.approvals === 2 && s.insights.errors === 1, 'approvals requested and session errors are counted');
assert(s.outcome === 'success' && s.summary === 'shipped it', 'the LATEST report wins, trimmed', `${s.outcome}/${s.summary}`);
assert(s.model === 'opus' && s.effort === 'high' && s.outputStyle === 'Concise', 'runtime tuning is stamped from session.tuning');
assert(s.blockedMs === 2_000 + 3_000, 'human-wait = answered questions + CLOSED approval spans only', String(s.blockedMs));
assert(s.artifacts === 1, 'deliverables are counted');

console.log('\npersistence');
const persisted = rowOf(done);
assert(persisted.gov_actions === 6 && persisted.outcome === 'success' && persisted.artifacts === 1, 'a terminal row is frozen onto the row');
db.prepare('DELETE FROM audit_events WHERE run_id = ?').run(done);
assert(listed(done).insights.actions === 6, '…and answered from the row afterwards, not re-derived');

console.log('\nedges');
const silent = mkRun();
ev(silent, 'gate.decision', { decision: { effect: 'allow' } });
assert(listed(silent).outcome === 'unknown', 'a finished run that never reported stamps `unknown`');
// created NOW: a `running` row older than the 10 s spawn grace with no tmux pane is reaped to
// `crashed` by the same list call, which would make this a test of markCrashed instead.
const live = mkRun({ status: 'running', createdAt: Date.now() });
ev(live, 'gate.decision', { decision: { effect: 'allow' } });
assert(listed(live).insights.actions === 1 && rowOf(live).gov_actions === null, 'a LIVE row is surfaced but never frozen');
ev(live, 'gate.decision', { decision: { effect: 'allow' } });
assert(listed(live).insights.actions === 2, '…and re-tallies while it moves');

console.log('\nchunking');
const many = [];
for (let i = 0; i < 450; i++) { const id = mkRun(); ev(id, 'gate.decision', { decision: { effect: 'allow' } }); many.push(id); }
const all = new Map(tm.listSessions(owner, 240).map((x) => [x.id, x]));
assert(many.every((id) => all.get(id)?.insights?.actions === 1), 'all 450 rows are stamped in one call (chunked past the 400 parameter page)');
assert(many.every((id) => rowOf(id).gov_actions === 1), '…and all 450 persisted');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
