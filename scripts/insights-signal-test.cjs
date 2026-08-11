#!/usr/bin/env node
/* Insights signal test (docs/insights-revisit.md, Step 0) — a number that rides in EVERY agent's system
 * prompt, or DMs a human, must not be derived from `success / sessions`.
 *
 * That ratio divides SELF-REPORTED successes by ALL sessions, so its complement is dominated by runs that
 * never called `report` at all. On live data (2026-08-08): northwind logged 334 `session.ended` with no
 * outcome against 302 `session.reported` in 30 days, and ONE reported failure in 329 reports lifetime
 * (globex: 6 in 1830). Both tenants computed ~55% "success" and broadcast it four ways — the injected
 * guidance line, a config recommendation, the tenant-shared memory Insight, and a `success-drop` DM.
 *
 * These cases pin all four shut. They're the fixture for Step 1: when an outcome derived from observable
 * facts lands, a rate may return — but it must fail `noRateWithoutFailures` below, i.e. it must move when
 * real failures move, not when reporting discipline does. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-insights-signal-'));
process.env.AGENT_OS_HOME = HOME;          // ⚠ never let loadAgentOS() resolve to the live ./data home
process.env.AGENT_OS_TENANT = 'testco';
delete process.env.AGENT_OS_SECRET_KEY;

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d ? ' — ' + d : ''}`));

const { deriveGuidance, deriveRecommendations, recommendationResolved } = require(path.join(ROOT, 'dist/edge/dreaming.js'));
const { loadAgentOS } = require(path.join(ROOT, 'dist/kernel.js'));
const { detectAlerts } = require(path.join(ROOT, 'dist/edge/alerts.js'));

const NOW = Date.now();
const DAY = 24 * 3600_000;

/** A state shaped like real live data: plenty of runs, a middling "success" share, and ZERO reported
 *  failures — every non-success is a run that stopped or never reported. */
const realistic = (over = {}) => ({
  firstPass: NOW - 30 * DAY, passes: 12, topics: {}, watermark: NOW,
  totals: { sessions: 635, episodes: 464, success: 291, failure: 0, partial: 44, stopped: 147, unknown: 153, approved: 24, rejected: 0, budgetStops: 0, errors: 0 },
  recent: [
    { day: 'd1', ts: NOW - 1 * DAY, sessions: 40, success: 22, failure: 0, stopped: 8, approved: 0, rejected: 0, budgetStops: 0, errors: 0, topics: [] },
    { day: 'd2', ts: NOW - 2 * DAY, sessions: 28, success: 17, failure: 0, stopped: 1, approved: 0, rejected: 0, budgetStops: 0, errors: 0, topics: [] },
    { day: 'd3', ts: NOW - 3 * DAY, sessions: 24, success: 17, failure: 0, stopped: 0, approved: 2, rejected: 0, budgetStops: 0, errors: 0, topics: [] },
  ],
  ...over,
});

console.log('\n\x1b[1mInsights signal — no prompt-injected or DM\'d number off `success / sessions`\x1b[0m');

// ── 1. The guidance line ───────────────────────────────────────────────────────────────────────────
{
  const s = realistic();
  const recentSessions = s.recent.reduce((n, r) => n + r.sessions, 0);
  const recentSuccess = s.recent.reduce((n, r) => n + r.success, 0);
  const bogusRate = Math.round((recentSuccess / recentSessions) * 100);
  const g = deriveGuidance(s);

  assert(bogusRate < 70 && recentSessions >= 5, 'fixture would have tripped the old gate', `rate ${bogusRate}% over ${recentSessions} sessions`);
  assert(!/success rate/i.test(g), 'guidance asserts no success rate', g);
  assert(!/slow down/i.test(g), 'guidance does not tell every agent to slow down');
  assert(!new RegExp(`${bogusRate}\\s*%`).test(g), `guidance does not contain the ${bogusRate}% figure`);
  assert(/recall/.test(g) && /kb_search/.test(g), 'the baseline recall/KB nudge still ships', g);
}

// ── 2. The config recommendation ───────────────────────────────────────────────────────────────────
{
  const recs = deriveRecommendations(realistic(), 'medium', NOW);
  assert(!recs.some((r) => r.id === 'runtime.effort.high'), 'no runtime.effort.high proposed', JSON.stringify(recs.map((r) => r.id)));
  assert(!recs.some((r) => r.apply), 'nothing auto-applyable is proposed off this state');

  // A persisted one from before the retirement must vanish at READ time, not wait for the next pass.
  assert(recommendationResolved({ id: 'runtime.effort.high' }, 'medium') === true, 'a legacy runtime.effort.high reads as resolved');
  assert(recommendationResolved({ id: 'policy.review' }, 'medium') === false, 'unrelated recommendations are untouched');
}

// ── 3. Friction signals that DO have a denominator still fire ──────────────────────────────────────
{
  // Not a blanket "no guidance ever": real, sampled, denominated friction must still reach agents.
  const s = realistic({ recent: [{ day: 'd1', ts: NOW - DAY, sessions: 40, success: 5, failure: 0, stopped: 8, approved: 2, rejected: 10, budgetStops: 3, errors: 4, topics: [] }] });
  const g = deriveGuidance(s);
  assert(/rejected at human approval/i.test(g), 'approval friction still fires (10 of 12 decisions rejected)');
  assert(/[Bb]udget/.test(g), 'budget friction still fires');
  assert(/errors/i.test(g), 'error friction still fires');
  assert(!/success rate/i.test(g), 'still no success rate, even alongside real friction');

  const recs = deriveRecommendations(s, 'medium', NOW);
  assert(recs.some((r) => r.id === 'policy.review'), 'policy.review still proposed on a real rejection rate');
  assert(recs.some((r) => r.id === 'budget.review'), 'budget.review still proposed');
}

// ── 4. The success-drop alert ──────────────────────────────────────────────────────────────────────
{
  const aos = loadAgentOS();
  let n = 0;
  /** One terminated run. `reported` false ⇒ it ended WITHOUT an outcome — the live majority case. */
  const mkRun = (ageDays, reported) => {
    const id = 'ts_' + (++n), at = NOW - ageDays * DAY;
    aos.db.prepare("INSERT INTO term_sessions (id,agent,title,task,tmux,status,headless,spawned_by,created_at,updated_at) VALUES (?,?,'t','x',?,'done',1,'m_alice',?,?)")
      .run(id, 'worker', 'aos-' + id, at, at + 60_000);
    aos.db.prepare("INSERT INTO audit_events (ts,tenant,run_id,principal,type,data) VALUES (?,?,?,'agent:worker','session.ended',?)")
      .run(at + 60_000, aos.tenant, id, JSON.stringify(reported ? { outcome: 'success' } : {}));
  };
  // Prior week: 20 runs, 18 reported success (90%). This week: 20 runs, 4 reported (20%) — a 70-point
  // "collapse" in which NOTHING failed; 16 runs merely exited without calling `report`.
  for (let i = 0; i < 20; i++) mkRun(9, i < 18);
  for (let i = 0; i < 20; i++) mkRun(2, i < 4);

  const alerts = detectAlerts(aos, NOW);
  assert(!alerts.some((a) => a.key === 'success-drop'), 'no success-drop alert on a 70-point reporting swing with zero failures', JSON.stringify(alerts.map((a) => a.key)));
  assert(!alerts.some((a) => a.key === 'agent-low:worker'), 'no agent-low either — that gate needs real reported failures');
}

// ── 5. The regression guard for Step 1 ─────────────────────────────────────────────────────────────
{
  // noRateWithoutFailures: whatever metric Step 1 introduces, two states that differ ONLY in how many runs
  // reported (identical real failures: none) must produce identical guidance. A metric that moves here is
  // measuring reporting discipline, not quality — the exact defect Step 0 removed.
  const quiet = realistic({ recent: [{ day: 'd1', ts: NOW - DAY, sessions: 40, success: 4, failure: 0, stopped: 0, approved: 0, rejected: 0, budgetStops: 0, errors: 0, topics: [] }] });
  const chatty = realistic({ recent: [{ day: 'd1', ts: NOW - DAY, sessions: 40, success: 38, failure: 0, stopped: 0, approved: 0, rejected: 0, budgetStops: 0, errors: 0, topics: [] }] });
  assert(deriveGuidance(quiet) === deriveGuidance(chatty), 'guidance is identical whether 10% or 95% of runs reported', `\n${deriveGuidance(quiet)}\n---\n${deriveGuidance(chatty)}`);
  assert(JSON.stringify(deriveRecommendations(quiet, 'medium', NOW)) === JSON.stringify(deriveRecommendations(chatty, 'medium', NOW)), 'recommendations are identical too');
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
