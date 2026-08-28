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

const { deriveGuidance, deriveRecommendations, recommendationResolved, topicCounts, TOPICS_VERSION } = require(path.join(ROOT, 'dist/edge/dreaming.js'));
const crypto = require('crypto');
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

// ── topics: what "the fleet frequently works on" is allowed to name ──────────────────────────────────
// This list rides in every agent's system prompt via deriveGuidance, so a junk token there is a junk
// token in every prompt. The fixtures are the exact shapes instapods and instawp surfaced on their first
// pass after the topic accumulator was fixed (2026-08-27).
{
  console.log('\n\x1b[1m4) topics — subjects, not states or handles\x1b[0m');
  const ep = (content) => ({ content, created_at: NOW });
  const got = new Map(topicCounts([
    ep('Task: WAIT for the FreeScout migration to finish, then verify apache2 is serving.'),
    ep('Task: WAIT for the queue to drain before restarting apache2.'),
    ep('Task: WAIT — do not proceed until the apache2 restart lands.'),
    ep('Task: Post the daily summary to Slack channel c05cl830mnd for the docs bot.'),
    ep('Task: Investigate site d3cby9k failing to load after the migration.'),
    ep('Task: Investigate site d2mp41k timing out on checkout.'),
    ep('Task: Skip anyone already-contacted-in-90-days when building the outreach list.'),
    ep('Task: Verify the php8 upgrade on dev3 did not break the oauth2 callback.'),
    ep('Task: Verify php8 handles the log4j scan and dev3 stays green.'),
  ]));
  const has = (t) => got.has(t);

  // A shouted imperative reads as an ACRONYM to properNouns (short, all-caps, standing alone), which is
  // how instawp's first clean pass told every agent the fleet "frequently works on … WAIT".
  assert(!has('wait'), 'a shouted imperative is not a topic', [...got.keys()].join(','));
  // Opaque handles the hex rule misses: a digit buried MID-token is an id or a slug, not a name.
  assert(!has('c05cl830mnd'), 'a Slack channel id is not a topic');
  assert(!has('d3cby9k') && !has('d2mp41k'), 'site handles are not topics');
  assert(!has('already-contacted-in-90-days'), 'a task slug is not a topic');
  // …while real tech names carry their digits at the END, and must survive.
  assert(has('apache2') && got.get('apache2') === 3, 'apache2 survives, counted once per episode');
  assert(has('php8') && has('dev3') && has('oauth2'), 'php8 / dev3 / oauth2 survive');
  assert(has('log4j'), 'a short name with an interior digit is below the length bound and survives');
  assert(has('freescout'), 'a plain product name survives');
}

// ── the extractor and TOPICS_VERSION must move together ─────────────────────────────────────────────
// `topics` is a CUMULATIVE map that decays only on a 21-day half-life, so changing what the extractor
// ADMITS does nothing about what it already admitted — the old words keep their counts and keep
// headlining the guidance line. TOPICS_VERSION exists to clear the map when the extractor's meaning
// changes, and a comment saying "bump this" has now failed to enforce it TWICE:
//   v0.281.3  tightened isEntity for opaque hex ids, no bump — the ids stayed.
//   v0.401.0  stopped extracting `wait`, `c05cl830mnd`, `d3cby9k`, `already-contacted-in-90-days`,
//             no bump — all four stayed in the live maps, and `wait:3` sat exactly on MIN_TOPIC_COUNT,
//             so it was still in the guidance line every agent read.
// So this fingerprints the extractor instead of trusting anyone to remember. When it fails, do BOTH
// things it tells you to; the hash is not a rubber stamp to update on its own.
{
  console.log('\n\x1b[1m5) the extractor cannot change without clearing the maps it poisoned\x1b[0m');
  const src = fs.readFileSync(path.join(ROOT, 'dist/edge/dreaming.js'), 'utf8');
  // Slice the extractor's own regions out of the compiled module: the stop-list literal and the three
  // functions that decide what counts as a topic. Compiled from the same TS, so a semantic change to any
  // of them moves the hash; edits ELSEWHERE in the file do not.
  // Each region must be FOUND and non-trivial. The first cut of this used '\n]);' to end the stop-list,
  // but tsc emits the array literal on ONE line, so the marker never matched, the slice silently became a
  // constant, and the whole stop-list contributed NOTHING to the hash — a fingerprint with a hole in it,
  // which would have passed the very change that prompted this test. Hence the length floors: a broken
  // anchor now fails here instead of quietly weakening the guard.
  const region = (startMark, endMark, minLen) => {
    const a = src.indexOf(startMark);
    const b = a >= 0 ? src.indexOf(endMark, a + startMark.length) : -1;
    const slice = a >= 0 && b > a ? src.slice(a, b) : '';
    assert(slice.length >= minLen,
      `fingerprint region "${startMark}" is intact`,
      slice.length ? `only ${slice.length} chars, expected >= ${minLen}` : 'anchor or end marker not found in dist/edge/dreaming.js');
    return slice;
  };
  const extractor = [
    region('STOP = new Set', ']);', 2000),         // the stop-list literal, one line after compilation
    region('function topicCounts', '\n}', 400),
    region('function properNouns', '\n}', 1500),
    region('function isEntity', '\n}', 400),
  ].join('\u0000');
  const hash = crypto.createHash('sha256').update(extractor).digest('hex').slice(0, 16);

  // ⚠ When this fails: the extractor changed. Bump TOPICS_VERSION in src/edge/dreaming.ts so every live
  // tenant rebuilds its topic map from the current corpus, THEN paste the new hash here.
  const PINNED = { version: 4, hash: 'bc0f006a6d11ecf2' };

  assert(hash === PINNED.hash,
    'the extractor is unchanged since TOPICS_VERSION was last bumped',
    `\n    extractor hash is ${hash}, pinned ${PINNED.hash}\n` +
    `    → the topic extractor changed. Bump TOPICS_VERSION (currently ${TOPICS_VERSION}) so live tenants\n` +
    `      clear the stale words it no longer admits, then set hash: '${hash}' here.`);
  assert(TOPICS_VERSION === PINNED.version,
    'TOPICS_VERSION matches the version this fingerprint was taken at',
    `TOPICS_VERSION=${TOPICS_VERSION}, fingerprint pinned at ${PINNED.version}`);
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail ? 1 : 0);
