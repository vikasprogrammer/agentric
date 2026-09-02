#!/usr/bin/env node
/* Per-agent maturity roll-up test — the read model behind `GET /api/agents/stats` and the trust chip.
 *
 * The roll-up was rewritten from "read every audit row and JSON.parse it" to "GROUP BY in SQL over a
 * covering index, and only open `data` for the two rare event types whose verdict lives in the payload"
 * (1,966 ms → ~50 ms on the live instawp tenant, 576k audit rows). Everything the rewrite could plausibly
 * break is pinned here, because none of it is visible from a passing typecheck:
 *   - every counter still lands on the right agent, via the run_id → session join;
 *   - a run is DENIED once, however many denial events it carries, and across all four denial kinds;
 *   - the LIKE pre-filter the partial index is built on is only a pre-filter: an ALLOW decision whose
 *     reason text quotes `"effect":"deny"` must not count as a denial;
 *   - malformed `data` never throws (the old JS path caught it; SQL json_extract would not have);
 *   - audit rows whose run we can't resolve ('-' housekeeping) are skipped, not attributed;
 *   - the derived scores (autonomy, denialRate, volumeConfidence, maturity) are unchanged;
 *   - both indexes the fast path relies on exist after migration.
 * Isolated home; pure over the DB (no tmux, no claude). */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-stats-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));
const near = (a, b) => Math.abs(a - b) < 1e-9;

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { computeAgentStats, computeAgentStat } = require(path.join(ROOT, 'dist/state/agent-stats.js'));

const aos = loadAgentOS();
const db = aos.db;

let seq = 0;
const session = (agent, status, extra = {}) => {
  const id = `s_${++seq}`;
  db.prepare(`INSERT INTO term_sessions (id, agent, tmux, status, spawned_by, run_as, task, title, created_at, updated_at, rating)
              VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)`)
    .run(id, agent, `tmux_${id}`, status, extra.spawnedBy ?? 'm_owner', extra.runAs ?? null, 1000 + seq, 2000 + seq, extra.rating ?? null);
  return id;
};
const audit = (runId, type, data) => db
  .prepare('INSERT INTO audit_events (ts, run_id, tenant, principal, type, data) VALUES (?, ?, ?, ?, ?, ?)')
  .run(Date.now(), runId, 'testco', 'tester', type, typeof data === 'string' ? data : JSON.stringify(data ?? {}));

// ── corpus ────────────────────────────────────────────────────────────────────
// alpha: 10 clean governed actions, one of them human-gated. No denial anywhere.
const a1 = session('alpha', 'done');
for (let i = 0; i < 10; i++) { audit(a1, 'gate.attempt', {}); audit(a1, 'gate.decision', { capability: 'shell.exec', decision: { effect: 'allow' } }); }
audit(a1, 'approval.requested', {});
audit(a1, 'approval.auto_approved', {});
// …plus a second alpha run that an ALLOW decision quotes the deny phrase in (the LIKE false positive).
const a2 = session('alpha', 'done');
audit(a2, 'gate.attempt', {});
audit(a2, 'gate.decision', { capability: 'shell.exec', decision: { effect: 'allow', reason: 'not a "effect":"deny" match — quoted in prose' } });

// beta: one run denied by policy TWICE, one killswitch run, one budget stop, one human rejection.
const b1 = session('beta', 'done');
audit(b1, 'gate.attempt', {}); audit(b1, 'gate.attempt', {});
audit(b1, 'gate.decision', { capability: 'net.http', decision: { effect: 'deny', reason: 'matched rule "*" → never' } });
audit(b1, 'gate.decision', { capability: 'net.http', decision: { effect: 'deny', reason: 'again' } });
const b2 = session('beta', 'crashed');
audit(b2, 'gate.killswitch', {});
audit(b2, 'session.error', {});
const b3 = session('beta', 'stopped');
audit(b3, 'budget.exceeded', {});
const b4 = session('beta', 'done');
audit(b4, 'approval.requested', {});
audit(b4, 'approval.resolved', { approved: false });
audit(b4, 'question.asked', {});
// gamma: only malformed payloads + an unresolvable run id.
const g1 = session('gamma', 'done');
audit(g1, 'gate.attempt', {});
audit(g1, 'approval.resolved', '{not json');
audit(g1, 'gate.decision', '{"decision":{"effect":"deny" truncated');
audit('-', 'gate.attempt', {});
audit('s_does_not_exist', 'gate.decision', { decision: { effect: 'deny' } });

const byId = Object.fromEntries(computeAgentStats(db, ['alpha', 'beta', 'gamma', 'delta']).map((s) => [s.agentId, s]));
const A = byId.alpha, B = byId.beta, G = byId.gamma, D = byId.delta;

console.log('\nagent-stats roll-up');
assert(A.actions.governed === 11 && A.runs.total === 2, 'gate.attempt is counted per agent across its runs', JSON.stringify(A.actions));
assert(A.actions.humanGated === 1 && A.actions.autoApproved === 1, 'approval.requested / auto_approved land on the agent');
assert(A.actions.denied === 0 && A.deniedRuns === 0, 'an ALLOW decision quoting `"effect":"deny"` in its reason is not a denial');
assert(B.actions.denied === 2, 'both policy denies on one run are counted', String(B.actions.denied));
assert(B.deniedRuns === 4, 'each denied RUN counts once — policy deny, killswitch, budget stop, rejection', String(B.deniedRuns));
assert(B.actions.killswitch === 1 && B.actions.budgetStops === 1 && B.actions.rejected === 1 && B.actions.errors === 1, 'the rare denial kinds keep their own tallies', JSON.stringify(B.actions));
assert(B.questions === 1, 'question.asked is rolled up');
assert(G.actions.governed === 1 && G.actions.denied === 0 && G.actions.rejected === 0, 'malformed audit `data` is skipped, not thrown on', JSON.stringify(G.actions));
assert(A.actions.governed + B.actions.governed + G.actions.governed === 14, "audit rows whose run can't be resolved are attributed to nobody");
assert(D && D.runs.total === 0 && D.confidence === 'none', 'an agent with no history is still listed, at confidence none');

console.log('\nderived scores');
assert(near(A.autonomy, 10 / 11), 'autonomy = (governed − humanGated) / governed', String(A.autonomy));
assert(near(B.denialRate, 1), 'denialRate = denied runs / runs', String(B.denialRate));
assert(near(A.volumeConfidence, 2 / 10) && near(A.maturity, (10 / 11) * 1 * (2 / 10)), 'maturity = autonomy × (1 − denialRate) × volumeConfidence', String(A.maturity));
assert(near(B.maturity, 0), 'an agent denied on every run has zero maturity');
assert(computeAgentStat(db, 'beta').deniedRuns === 4, 'the single-agent convenience view matches the fleet roll-up');

console.log('\nindexes the fast path depends on');
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_audit_type_run','idx_audit_deny')").all().map((r) => r.name).sort();
assert(idx.join() === 'idx_audit_deny,idx_audit_type_run', 'migration creates the (type, run_id) covering index and the partial deny index', idx.join());
const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT type, run_id, COUNT(*) AS n FROM audit_events WHERE type IN ('gate.attempt') GROUP BY type, run_id`).all().map((r) => r.detail).join(' ');
assert(/COVERING INDEX idx_audit_type_run/.test(plan), 'the tally never touches the `data` column (covering index)', plan);

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
