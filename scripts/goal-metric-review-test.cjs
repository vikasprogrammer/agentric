#!/usr/bin/env node
/* Goal metrics + the performance review — judging a goal on whether the NUMBER moved.
 *
 * The failure this pins is a review that lies confidently. Two directions:
 *   - calling a goal FAILING on thin evidence (one reading, three readings taken the same afternoon,
 *     a wobble smaller than the noise) — which trains everyone to ignore the card;
 *   - calling a goal FINE because work happened, which is the exact blindness the metric exists to fix,
 *     and which reads backwards on the many real goals where DOWN is winning.
 *
 * Also pinned: one standing card per goal rather than one per tick, and the fact that an agent may
 * report the number but not move the goalposts.
 *
 * Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-goalmetric-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 260) : ''}`));

const DAY = 86_400_000;

(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { reviewGoals } = require(path.join(ROOT, 'dist/edge/goal-review.js'));
  const { metricBrief } = require(path.join(ROOT, 'dist/edge/strategist.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const post = async (p, b) => (await fetch(base + p, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
  const get = async (p) => (await fetch(base + p, { headers: { cookie } })).json();

  const NOW = Date.now();
  const mkGoal = (title, metric) => aos.goals.create({ tenant: aos.tenant, title, metric, owner: owner.id, createdBy: owner.id });
  /** Readings at fixed days-ago, so a verdict depends on real elapsed time, not on test speed. */
  const feed = (g, pairs) => pairs.forEach(([daysAgo, v]) => aos.goals.addReading(g.id, v, 'agent:analytics', { at: NOW - daysAgo * DAY }));
  const cards = (goalId) => aos.db.prepare("SELECT id, title, status FROM messages WHERE session_id = ? ORDER BY id").all(`system:goal-review-${goalId}`);
  const openCards = (goalId) => cards(goalId).filter((c) => c.status === 'open');

  console.log('\n\x1b[1m1) A goal with no metric behaves exactly as before\x1b[0m');
  const plain = mkGoal('Ship the redesign');
  assert(plain.metric === undefined, 'no metric is stored');
  assert(aos.goals.metricStatus(plain.id) === undefined, 'no metric status to compute');
  assert(metricBrief(aos, plain).length === 0, 'and the strategist prompt says nothing about metrics');
  assert(reviewGoals(aos, tm, NOW).every((r) => r.goalId !== plain.id), 'the review skips it entirely');

  console.log('\n\x1b[1m2) A number that is moving the right way is left alone\x1b[0m');
  const up = mkGoal('Grow organic sessions', { name: 'organic sessions / mo', target: 20000, baseline: 12000, everyDays: 7 });
  feed(up, [[21, 12000], [14, 14000], [7, 16000], [0, 17500]]);
  const upSt = aos.goals.metricStatus(up.id, NOW);
  assert(upSt.verdict === 'measuring', 'verdict is `measuring`', upSt.verdict);
  assert(upSt.percent === 69, 'percent to target is measured from the baseline, not from zero', upSt.percent);
  assert(reviewGoals(aos, tm, NOW).find((r) => r.goalId === up.id).carded === false, 'a healthy goal raises NO card');

  console.log('\n\x1b[1m3) A number that is not moving is called out — but only on real evidence\x1b[0m');
  const flat = mkGoal('Push AI citations', { name: 'citations / mo', target: 80, baseline: 40, everyDays: 7 });
  feed(flat, [[0, 41]]);
  assert(aos.goals.metricStatus(flat.id, NOW).verdict === 'new', 'ONE reading is never enough to call a goal flat');
  feed(flat, [[2, 40], [4, 41]]);
  assert(aos.goals.metricStatus(flat.id, NOW).verdict === 'new', 'three readings inside one week are still not enough — a verdict needs a time span');
  feed(flat, [[21, 40], [14, 41]]);
  const flatSt = aos.goals.metricStatus(flat.id, NOW);
  assert(flatSt.verdict === 'flat', 'readings spanning three weeks with no movement → `flat`', flatSt.verdict);
  assert(Math.abs(flatSt.moved) <= 1, 'and the movement it reports is the real one', flatSt.moved);
  const flatReview = reviewGoals(aos, tm, NOW).find((r) => r.goalId === flat.id);
  assert(flatReview.carded === true, 'a card is raised');
  assert(openCards(flat.id).length === 1 && /not moving/i.test(openCards(flat.id)[0].title), 'and it says the goal is not moving', openCards(flat.id)[0]?.title);

  console.log('\n\x1b[1m4) One standing card, not one per tick\x1b[0m');
  reviewGoals(aos, tm, NOW); reviewGoals(aos, tm, NOW); reviewGoals(aos, tm, NOW);
  assert(openCards(flat.id).length === 1, 'three more reviews leave exactly ONE open card');
  assert(cards(flat.id).length === 1, 'and no superseded clutter behind it');

  console.log('\n\x1b[1m5) Down-is-better goals are not read backwards\x1b[0m');
  const down = mkGoal('Cut production incidents', { name: 'incidents / mo', target: 2, baseline: 10, direction: 'down', everyDays: 7 });
  feed(down, [[21, 10], [14, 7], [0, 4]]);
  assert(aos.goals.metricStatus(down.id, NOW).verdict === 'measuring', 'falling toward a lower target is PROGRESS', aos.goals.metricStatus(down.id, NOW));
  const wrongWay = mkGoal('Cut p95 latency', { name: 'p95 ms', target: 200, baseline: 400, direction: 'down', everyDays: 7 });
  feed(wrongWay, [[21, 400], [14, 500], [0, 600]]);
  assert(aos.goals.metricStatus(wrongWay.id, NOW).verdict === 'regressing', 'rising against a lower target is REGRESSION');
  const hit = mkGoal('Cut churn', { name: 'churn %', target: 3, baseline: 8, direction: 'down', everyDays: 7 });
  feed(hit, [[14, 8], [0, 2.4]]);
  assert(aos.goals.metricStatus(hit.id, NOW).verdict === 'achieved', 'passing a lower target is ACHIEVED, not regression');

  console.log('\n\x1b[1m6) "Nobody is measuring this" is its own finding\x1b[0m');
  const stale = mkGoal('Grow newsletter', { name: 'subscribers', target: 5000, baseline: 1000, everyDays: 7 });
  feed(stale, [[40, 1000], [30, 1200], [25, 1300]]);
  const staleSt = aos.goals.metricStatus(stale.id, NOW);
  assert(staleSt.verdict === 'unmeasured', 'readings older than twice the interval → `unmeasured`, not a movement verdict', staleSt.verdict);
  assert(staleSt.staleDays === 25, 'it reports how stale', staleSt.staleDays);
  assert(/Nobody is measuring/i.test(openCards(stale.id)[0]?.title || '') || reviewGoals(aos, tm, NOW).find((r) => r.goalId === stale.id).verdict === 'unmeasured', 'and the card names that, rather than claiming failure');
  const never = mkGoal('Someday goal', { name: 'a number', everyDays: 1 });
  aos.db.prepare('UPDATE goals SET created_at = ? WHERE id = ?').run(NOW - 10 * DAY, never.id);
  assert(aos.goals.metricStatus(never.id, NOW).verdict === 'unmeasured', 'a metric never once measured is unmeasured, once a reading was due');

  console.log('\n\x1b[1m7) The strategist is told the verdict, in words\x1b[0m');
  const brief = metricBrief(aos, aos.goals.get(flat.id)).join('\n');
  assert(/VERDICT: FLAT/.test(brief), 'the flat verdict is spelled out, not left to be inferred from numbers');
  assert(/DIFFERENT approach/i.test(brief), 'and it says not to file more of the same');
  assert(/higher is better/i.test(brief), 'direction is stated');
  assert(/VERDICT: UNMEASURED/.test(metricBrief(aos, aos.goals.get(stale.id)).join('\n')), 'an unmeasured goal tells the planner to establish measurement first');

  console.log('\n\x1b[1m8) Readings are governed: report the number, never move the goalposts\x1b[0m');
  const ok = await post(`/api/goals/${up.id}/readings`, { value: 18000, note: 'GA4 weekly' });
  assert(ok.ok === true && ok.reading.source === owner.id, 'an owner can record a reading, credited to them', ok.reading?.source);
  const bad = await post(`/api/goals/${up.id}/readings`, { value: 'lots' });
  assert(!bad.ok && /number/.test(bad.error || ''), 'a non-numeric reading is refused', bad);
  const noMetric = await post(`/api/goals/${plain.id}/readings`, { value: 5 });
  assert(!noMetric.ok && /no metric/.test(noMetric.error || ''), 'a goal with no metric refuses readings', noMetric);
  assert(aos.goals.addReading(up.id, Number.NaN, owner.id) === undefined, 'NaN is refused at the store, not stored to poison later verdicts');
  const detail = await get(`/api/goals/${up.id}`);
  assert(detail.metricStatus && detail.readings.length >= 5, 'the goal detail carries the status + readings for the console');
  assert(aos.goals.events(up.id).some((e) => /measured 18000/.test(e.body || '')), 'a reading also lands on the goal timeline, so a measured goal is never reported "stuck"');

  server.close();
  registry.stopAll();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
