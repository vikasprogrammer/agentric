#!/usr/bin/env node
/* Insight-alert staleness test — an alert must describe the PRESENT, not a healed past.
 *
 * Both conditions here are monotonic counters that only ever grow inside their window, so before the fix
 * they kept re-firing (every 3-day cooldown) long after the underlying problem was solved:
 *   · `agent-crash:<agent>` counted crashes over 30 days → a fixed crash loop re-alerted for ~4 more weeks.
 *   · `friction:<capability>` counted rejections over ALL TIME → re-alerted forever, unkillable.
 * Isolated home; rows are synthesized directly so the timing cases are exact. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-alert-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { detectAlerts } = require(path.join(ROOT, 'dist/edge/alerts.js'));
const { buildInsights } = require(path.join(ROOT, 'dist/edge/insights.js'));

const aos = loadAgentOS();
const DAY = 24 * 3600_000;
const NOW = Date.now();

let n = 0;
/** One terminated session `ageDays` ago. `crashed` rows carry no terminal audit event, like a real crash. */
const mkRun = (agent, status, ageDays) => {
  const id = 'ts_' + (++n), at = NOW - ageDays * DAY;
  aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'m_alice',?,?)")
    .run(id, agent, 't', 'x', 'aos-' + id, status, at, at + 60_000);
  if (status === 'done') {
    aos.db.prepare("INSERT INTO audit_events (ts,tenant,run_id,principal,type,data) VALUES (?,?,?,'agent:x','session.ended',?)")
      .run(at + 60_000, aos.tenant, id, JSON.stringify({ outcome: 'success' }));
  }
  return id;
};
const mkRejection = (capability, ageDays) => {
  const id = 'ap_' + (++n);
  aos.db.prepare("INSERT INTO approvals (id,run_id,tenant,level,capability,args,reason,status,created_at) VALUES (?,?,?,'owner',?,'{}','because','rejected',?)")
    .run(id, 'ts_x', aos.tenant, capability, NOW - ageDays * DAY);
};
const keys = () => detectAlerts(aos, NOW).map((a) => a.key);
const scoreFor = (agent) => buildInsights(aos, NOW).agents.find((a) => a.agent === agent);
const wipeRuns = () => aos.db.exec('DELETE FROM term_sessions; DELETE FROM audit_events');

console.log('\n\x1b[1m1) an ONGOING crash loop still alerts\x1b[0m');
for (let i = 0; i < 4; i++) mkRun('crasher', 'crashed', i * 0.5);   // 4 crashes inside the last 2 days
assert(keys().includes('agent-crash:crasher'), 'recent crashes → alert fires');
assert(scoreFor('crasher').crashedRecent === 4, 'crashedRecent counts the recent burst');

console.log('\n\x1b[1m2) a HEALED crash loop goes quiet (the regression)\x1b[0m');
wipeRuns();
for (let i = 0; i < 9; i++) mkRun('healed', 'crashed', 20 + i);      // 9 crashes, 20–28 days ago
assert(scoreFor('healed').crashed === 9, '30d scorecard still shows the 9 crashes (history is kept)');
assert(scoreFor('healed').crashedRecent === 0, 'none are recent');
assert(!keys().includes('agent-crash:healed'), 'crashes older than the recency window → NO alert');

console.log('\n\x1b[1m3) recovery threshold — clean runs since the last crash stand the alert down\x1b[0m');
wipeRuns();
for (let i = 0; i < 4; i++) mkRun('flaky', 'crashed', 3 + i * 0.1);  // recent burst, ~3 days ago
mkRun('flaky', 'done', 1); mkRun('flaky', 'done', 0.9);             // only 2 clean runs since
assert(scoreFor('flaky').runsSinceCrash === 2, 'runsSinceCrash = 2');
assert(keys().includes('agent-crash:flaky'), '2 clean runs is not yet recovery → still alerts');
mkRun('flaky', 'done', 0.8);                                        // the 3rd clean run
assert(scoreFor('flaky').runsSinceCrash === 3, 'runsSinceCrash = 3');
assert(!keys().includes('agent-crash:flaky'), '3 clean runs → recovered, alert stands down');

console.log('\n\x1b[1m4) rejection friction is windowed, not all-time\x1b[0m');
wipeRuns();
for (let i = 0; i < 30; i++) mkRejection('stripe.refund', 40 + i);  // all 40+ days old
assert(!keys().includes('friction:stripe.refund'), 'rejections older than the window → NO alert');
assert(buildInsights(aos, NOW).friction.rejections.length === 0, 'and they leave the Friction card too');
for (let i = 0; i < 6; i++) mkRejection('slack.send', i);           // 6 in the last week
assert(keys().includes('friction:slack.send'), 'current rejections still alert');

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
