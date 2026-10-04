#!/usr/bin/env node
/* The goal heartbeat — when a measured goal goes quiet, say WHY and what to do.
 *
 * The failure this pins is the one the instapods growth trial produced live (2026-09-24 → 10-01):
 * `metricStatus` correctly went `unmeasured`, a card fired, it was DM'd, and nothing happened —
 * because the card described the symptom ("nobody is measuring this") while the actual faults were
 * mechanical and invisible from the goal: an expired runtime credential refusing every launch, then a
 * session a human had claimed and left open, which made the scheduler skip each cycle silently.
 *
 * So: each cause is diagnosed from the runner's own sessions/automations, the TITLE names the fault,
 * the body carries the fix, and a stall whose cause changes re-cards (same verdict, different fix).
 * Also pinned: the healthy path is untouched, and a cause is only claimed on unambiguous evidence.
 *
 * Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-heartbeat-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const DAY = 86_400_000;
const HOUR = 3_600_000;

(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { reviewGoals } = require(path.join(ROOT, 'dist/edge/goal-review.js'));
  const { heartbeat } = require(path.join(ROOT, 'dist/edge/goal-heartbeat.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');

  const NOW = Date.now();
  const METRIC = { name: 'clicks per day', unit: 'clicks/day', baseline: 50, target: 100, direction: 'up', everyDays: 1 };
  const mkGoal = (title) => aos.goals.create({ tenant: aos.tenant, title, metric: METRIC, owner: owner.id, createdBy: owner.id });
  /** A reading, by a named runner, at a fixed age — staleness has to come from real elapsed time. */
  const read = (g, runner, daysAgo, v) => aos.goals.addReading(g.id, v, `agent:${runner}`, { at: NOW - daysAgo * DAY });
  /** A session row for a runner, written directly: the point is the SHAPE the heartbeat reads. */
  let seq = 0;
  const session = (agent, { status, hoursAgo, turns = 0, claimedBy = null, refused = null }) => {
    const id = `ses_hb${String(++seq).padStart(4, '0')}`;
    const at = NOW - hoursAgo * HOUR;
    aos.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, created_at, secret, updated_at, turns, claimed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, agent, 'run', 'run', `aos-${id}`, status, 'automation:au_x', at, 's', at, turns, claimedBy);
    if (refused) {
      aos.audit.append({ ts: at, runId: id, tenant: aos.tenant, principal: 'system', type: 'session.launch.refused', data: { runtime: 'claude-code', reason: refused } });
    }
    return id;
  };
  const trigger = (agent, enabled = 1) => {
    const id = `au_hb${String(++seq).padStart(4, '0')}`;
    aos.db.prepare('INSERT INTO automations (id, agent_id, name, type, schedule, secret, task, enabled, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, agent, 'loop', 'cron', '15 10 * * *', '', 'run the loop', enabled, owner.id, NOW - 20 * DAY);
    return id;
  };
  const cardsFor = (goalId) => aos.db.prepare('SELECT title, body, status FROM messages WHERE session_id = ? ORDER BY id').all(`system:goal-review-${goalId}`);
  const openCard = (goalId) => cardsFor(goalId).filter((c) => c.status === 'open').pop();

  console.log('\n\x1b[1m1) A goal measured on time is never diagnosed\x1b[0m');
  const healthy = mkGoal('Healthy goal');
  trigger('runner-ok');
  [3, 2, 1, 0].forEach((d, i) => read(healthy, 'runner-ok', d, 60 + i * 3));
  session('runner-ok', { status: 'done', hoursAgo: 2, turns: 3 });
  const okRun = reviewGoals(aos, tm, NOW).find((r) => r.goalId === healthy.id);
  assert(okRun && okRun.verdict !== 'unmeasured', 'verdict is not a stall', okRun);
  assert(okRun && okRun.cause === undefined, 'no cause is computed for a healthy goal', okRun);

  console.log('\n\x1b[1m2) Expired runtime credential — nothing ever started\x1b[0m');
  const cred = mkGoal('Credential stall');
  read(cred, 'runner-cred', 9, 51);
  trigger('runner-cred');
  session('runner-cred', { status: 'crashed', hoursAgo: 50, refused: 'credential expired: no refresh token left' });
  session('runner-cred', { status: 'crashed', hoursAgo: 26, refused: 'credential expired: no refresh token left' });
  const hbCred = heartbeat(aos, aos.goals.get(cred.id), NOW);
  assert(hbCred.cause === 'credential', 'cause is credential', hbCred);
  assert(hbCred.runner === 'runner-cred', 'the runner is identified from the readings', hbCred);
  assert(hbCred.evidence.refused === 2 && hbCred.evidence.ok === 0, 'both refused launches are counted', hbCred.evidence);
  assert(/re-login/i.test(hbCred.fix), 'the fix says re-login', hbCred.fix);
  const credRun = reviewGoals(aos, tm, NOW).find((r) => r.goalId === cred.id);
  assert(credRun && credRun.verdict === 'unmeasured' && credRun.carded, 'it cards', credRun);
  const credCard = openCard(cred.id);
  assert(credCard && /runtime login expired/.test(credCard.title), 'the TITLE names the fault, not the symptom', credCard && credCard.title);
  assert(credCard && /no refresh token left/.test(credCard.body), 'the body quotes the refusal reason', credCard && credCard.body.slice(0, 200));
  assert(credCard && /Fix:/.test(credCard.body), 'the body carries a fix line', credCard && credCard.body.slice(0, 200));

  console.log('\n\x1b[1m3) A parked session blocking the schedule\x1b[0m');
  const blocked = mkGoal('Blocked stall');
  read(blocked, 'runner-blocked', 9, 52);
  trigger('runner-blocked');
  const parked = session('runner-blocked', { status: 'running', hoursAgo: 60, turns: 1, claimedBy: owner.id });
  const hbBlocked = heartbeat(aos, aos.goals.get(blocked.id), NOW);
  assert(hbBlocked.cause === 'blocked', 'cause is blocked', hbBlocked);
  assert(hbBlocked.evidence.blockedSession === parked, 'it names the session holding the slot', hbBlocked.evidence);
  const blockedCard = (reviewGoals(aos, tm, NOW), openCard(blocked.id));
  assert(blockedCard && /parked session/.test(blockedCard.title), 'the title says a parked session is blocking it', blockedCard && blockedCard.title);
  assert(blockedCard && blockedCard.body.includes(parked), 'the fix names the session to stop', blockedCard && blockedCard.body.slice(-200));

  console.log('\n\x1b[1m4) Runs fine, never records the number\x1b[0m');
  const quiet = mkGoal('Not reporting');
  read(quiet, 'runner-quiet', 9, 53);
  trigger('runner-quiet');
  session('runner-quiet', { status: 'done', hoursAgo: 30, turns: 4 });
  session('runner-quiet', { status: 'done', hoursAgo: 5, turns: 6 });
  const hbQuiet = heartbeat(aos, aos.goals.get(quiet.id), NOW);
  assert(hbQuiet.cause === 'not-reporting', 'cause is not-reporting', hbQuiet);
  assert(/goal_measure/.test(hbQuiet.fix), 'the fix points at goal_measure', hbQuiet.fix);

  console.log('\n\x1b[1m5) No enabled trigger left\x1b[0m');
  const notrig = mkGoal('No trigger');
  read(notrig, 'runner-notrig', 9, 54);
  trigger('runner-notrig', 0);
  const hbNoTrig = heartbeat(aos, aos.goals.get(notrig.id), NOW);
  assert(hbNoTrig.cause === 'no-trigger', 'a disabled automation is not a trigger', hbNoTrig);

  console.log('\n\x1b[1m6) Nobody has ever measured it — no runner to blame\x1b[0m');
  const never = mkGoal('Never measured');
  const hbNever = heartbeat(aos, aos.goals.get(never.id), NOW);
  assert(hbNever.cause === 'silent' && hbNever.runner === undefined, 'cause is silent, no runner', hbNever);
  // A brand-new goal is `new` until its first reading is DUE, so review it past that point.
  reviewGoals(aos, tm, NOW + 2 * DAY);
  const neverCard = openCard(never.id);
  assert(neverCard && /Nobody is measuring/.test(neverCard.title), 'it keeps the original symptom title', neverCard && neverCard.title);
  assert(neverCard && /goal_measure/.test(neverCard.body), 'and still says how to start measuring', neverCard && neverCard.body.slice(0, 200));

  console.log('\n\x1b[1m6b) Evidence is counted only since the last reading\x1b[0m');
  // Live trap (2026-09-27): a run that succeeded BEFORE the number went stale explained nothing, yet it
  // out-voted two fresh refusals and the cause came back `unknown`.
  const mixed = mkGoal('Stale after a good run');
  read(mixed, 'runner-mixed', 9, 55);
  trigger('runner-mixed');
  session('runner-mixed', { status: 'done', hoursAgo: 14 * 24, turns: 5 });   // older than the reading
  session('runner-mixed', { status: 'crashed', hoursAgo: 40, refused: 'credential expired: no refresh token left' });
  session('runner-mixed', { status: 'crashed', hoursAgo: 16, refused: 'credential expired: no refresh token left' });
  const hbMixed = heartbeat(aos, aos.goals.get(mixed.id), NOW);
  assert(hbMixed.cause === 'credential', 'the pre-stall success does not out-vote fresh refusals', hbMixed);
  assert(hbMixed.evidence.ok === 0, 'and it is not counted as evidence at all', hbMixed.evidence);

  console.log('\n\x1b[1m6c) A trigger that silently stopped firing\x1b[0m');
  // The scheduler's pile-up guard skips a cycle and records NOTHING — no session, no failure — which is
  // how three days of the live stall left no trace at all. The honest reading is "it is not firing".
  const skipped = mkGoal('Trigger not firing');
  read(skipped, 'runner-skipped', 6, 56);
  const auId = trigger('runner-skipped');
  aos.db.prepare('UPDATE automations SET last_fired_at = ? WHERE id = ?').run(NOW - 6 * DAY, auId);
  const hbSkipped = heartbeat(aos, aos.goals.get(skipped.id), NOW);
  assert(hbSkipped.cause === 'not-firing', 'cause is not-firing', hbSkipped);
  assert(/6 days/.test(hbSkipped.detail), 'it says how long it has been quiet', hbSkipped.detail);
  assert(/still alive/.test(hbSkipped.fix), 'and points at the live-session cause', hbSkipped.fix);
  reviewGoals(aos, tm, NOW);
  const skippedCard = openCard(skipped.id);
  assert(skippedCard && /no enabled trigger|Nobody is measuring/.test(skippedCard.title) === false, 'the title is not the symptom wording', skippedCard && skippedCard.title);

  console.log('\n\x1b[1m7) The cause is part of the once-guard\x1b[0m');
  const before = cardsFor(cred.id).length;
  reviewGoals(aos, tm, NOW + HOUR);
  assert(cardsFor(cred.id).length === before, 'the same cause does not re-card', cardsFor(cred.id).length);
  // The credential gets fixed, the run starts... and parks. Same verdict, different fix.
  aos.db.prepare("UPDATE term_sessions SET status = 'running', turns = 1, claimed_by = ?, updated_at = ? WHERE agent = 'runner-cred'").run(owner.id, NOW - 40 * HOUR);
  aos.db.prepare("DELETE FROM audit_events WHERE type = 'session.launch.refused' AND run_id IN (SELECT id FROM term_sessions WHERE agent = 'runner-cred')").run();
  const after = reviewGoals(aos, tm, NOW + 2 * HOUR).find((r) => r.goalId === cred.id);
  assert(after && after.cause === 'blocked' && after.carded, 'a changed cause re-cards', after);
  assert(cardsFor(cred.id).length === before + 1, 'exactly one more card', cardsFor(cred.id).length);
  const openNow = cardsFor(cred.id).filter((c) => c.status === 'open');
  assert(openNow.length === 1 && /parked session/.test(openNow[0].title), 'and the old card is superseded, not left open', openNow.map((c) => c.title));

  console.log('\n\x1b[1m8) The diagnosis is in the audit trail\x1b[0m');
  const row = aos.db.prepare("SELECT data FROM audit_events WHERE type = 'goal.reviewed' AND data LIKE ? ORDER BY ts DESC LIMIT 1").get(`%${cred.id}%`);
  const data = JSON.parse(row.data);
  assert(data.cause === 'blocked' && data.runner === 'runner-cred', 'cause + runner are audited', data);
  assert(data.evidence && typeof data.evidence.refused === 'number', 'the evidence counts ride along', data.evidence);

  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} process.exit(1); });
