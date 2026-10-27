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
  // The human side takes `at` too, through the same validator — it used to accept a raw epoch with no
  // bound, so an admin could date a reading ahead of now and freeze the staleness sweep for good.
  const ownerFuture = await post(`/api/goals/${up.id}/readings`, { value: 1, at: Date.now() + 5 * DAY });
  assert(!ownerFuture.ok && /future/i.test(ownerFuture.error || ''), 'an owner cannot date a reading into the future either', ownerFuture);
  const ownerDated = await post(`/api/goals/${up.id}/readings`, { value: 17900, at: '2026-10-01', note: 'GA4, week ending 10-01' });
  assert(ownerDated.ok === true && new Date(ownerDated.reading.at).toISOString().slice(0, 10) === '2026-10-01', 'and can file a past window by date', ownerDated.reading?.at);
  const detail = await get(`/api/goals/${up.id}`);
  assert(detail.metricStatus && detail.readings.length >= 5, 'the goal detail carries the status + readings for the console');
  assert(aos.goals.events(up.id).some((e) => /measured 18000/.test(e.body || '')), 'a reading also lands on the goal timeline, so a measured goal is never reported "stuck"');


  console.log('\n\x1b[1m9) An agent can date a reading to the window it measures (backfill)\x1b[0m');
  // The bug: `goal_measure` took only goalId/value/note, so an agent that had JUST measured six real
  // weekly windows filed them all within seconds. `metricStatus` needs a sample SPANNING the metric's
  // interval, so a live support goal provably 69% of the way to target reported `new`. Dating the
  // reading is what lets a goal be born with the history somebody already measured.
  const agentId = [...aos.agents.values()][0].id;
  const SES = 'ses_measure_at';
  aos.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, created_at, secret, updated_at, run_as, claude_session_id, headless) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(SES, agentId, 'run', 'run', `aos-${SES}`, 'running', 'automation:au_x', Date.now(), `sec-${SES}`, Date.now(), owner.id, `claude-${SES}`);
  const measure = async (body) => (await fetch(base + '/api/goals/measure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aos-secret': `sec-${SES}` },
    body: JSON.stringify({ session: SES, ...body }),
  })).json();
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

  const bf = mkGoal('Draft adoption to 85', { name: 'adoption', unit: '%', target: 85, baseline: 55, direction: 'up', everyDays: 7 });

  // Backfilling with no `at` is the OLD behaviour, and it is why the verdict was useless: six readings
  // that all land now cannot span a 7-day interval however many there are.
  for (const v of [53.5, 62.5, 58.2, 54.3, 75, 75.6]) await measure({ goalId: bf.id, value: v });
  const collapsed = aos.goals.metricStatus(bf.id);
  assert(aos.goals.readings(bf.id).length === 6, 'six readings were accepted', aos.goals.readings(bf.id).length);
  assert(collapsed.verdict === 'new', 'but same-instant readings still read as `new` — the sample spans no time', collapsed.verdict);
  assert(collapsed.percent === 69, 'even though the number is provably 69% of the way to target', collapsed.percent);

  // Dated the same way a real backfill would be, the verdict becomes real.
  const dated = mkGoal('Draft adoption to 85 (dated)', { name: 'adoption', unit: '%', target: 85, baseline: 55, direction: 'up', everyDays: 7 });
  const weeks = [[49, 53.5], [42, 62.5], [35, 58.2], [28, 54.3], [21, 75], [14, 75.6]];
  for (const [daysAgo, v] of weeks) {
    const r = await measure({ goalId: dated.id, value: v, at: ymd(NOW - daysAgo * DAY), note: `week ending ${ymd(NOW - daysAgo * DAY)}` });
    assert(r.ok === true, `reading for ${ymd(NOW - daysAgo * DAY)} accepted`, r);
  }
  const rs = aos.goals.readings(dated.id);
  assert(new Set(rs.map((r) => ymd(r.at))).size === 6, 'the six readings land on six different days', rs.map((r) => ymd(r.at)));
  assert(rs.every((r) => Math.abs(r.at - (NOW - weeks.find(([, v]) => v === r.value)[0] * DAY)) < 13 * 3600_000), 'each is dated to its own window (date-only anchored mid-day UTC)');
  const datedSt = aos.goals.metricStatus(dated.id, NOW);
  assert(datedSt.verdict === 'measuring', 'NOW the plane can see the trend: verdict is `measuring`', datedSt.verdict);
  assert(datedSt.readings === 6 && datedSt.first.value === 53.5, '`first` is the oldest WINDOW, not the first row written', { n: datedSt.readings, first: datedSt.first.value });

  console.log('\n\x1b[1m9b) …but it cannot date a reading into the future, or absurdly far back\x1b[0m');
  // A future reading is the dangerous one: `staleDays` goes negative, so the staleness sweep would never
  // report that goal unmeasured again — a silent way to make a dead goal look alive forever.
  const future = await measure({ goalId: dated.id, value: 99, at: ymd(NOW + 3 * DAY) });
  assert(future.ok !== true && /future/i.test(future.error || ''), 'a future `at` is refused, naming why', future);
  const ancient = await measure({ goalId: dated.id, value: 1, at: '2015-01-01' });
  assert(ancient.ok !== true && /years/i.test(ancient.error || ''), 'an `at` further back than the bound is refused', ancient);
  const garbage = await measure({ goalId: dated.id, value: 1, at: 'last tuesday' });
  assert(garbage.ok !== true && /YYYY-MM-DD/.test(garbage.error || ''), 'an unparseable `at` is refused rather than silently filed as now', garbage);
  assert(aos.goals.readings(dated.id).length === 6, 'none of the three refusals wrote a reading', aos.goals.readings(dated.id).length);
  const stillOk = await measure({ goalId: dated.id, value: 77.1 });
  assert(stillOk.ok === true, 'omitting `at` still works and means "now"', stillOk);

  console.log('\n\x1b[1m9c) A backfilled reading is legible in the audit trail\x1b[0m');
  // Readings are append-only and `source` already names the agent, but an agent filing HISTORY reshapes
  // its own apparent trend, so that has to be visible without diffing timestamps.
  const evs = aos.db.prepare("SELECT data FROM audit_events WHERE type = 'goal.measured' ORDER BY id").all().map((r) => JSON.parse(r.data));
  const backfills = evs.filter((d) => d.backfilled === true);
  assert(backfills.length === 7, 'every dated reading is audited `backfilled: true` — the agent\'s six and the owner\'s one', backfills.length);
  assert(backfills.filter((d) => d.goalId === dated.id).length === 6, 'six of them are the agent backfill', backfills.length);
  assert(evs.filter((d) => d.goalId === dated.id && !d.backfilled).length === 1, 'the undated "now" reading is NOT flagged as a backfill');
  assert(evs.every((d) => typeof d.at === 'number'), 'and every goal.measured event records the date it was filed under');

  server.close();
  console.log('\n\x1b[1mX) "Ready to close" asks the NUMBER, not the task list\x1b[0m');
  // Live (instapods clicks goal): every filed task was done, so the room offered "Ready to close" and the
  // sweep carded the owner that the goal was finished — beside a metric panel reading 59 of 100, "Not
  // moving". Task completion is the weakest evidence a measured goal has; it does not get a vote.
  const mkTask = (goalId, status) => {
    const t = aos.tasks.create({ tenant: aos.tenant, title: `work for ${goalId}`, goalId, createdBy: owner.id, owner: owner.id });
    if (status !== 'todo') aos.tasks.update(t.id, { status, by: owner.id });
    return t;
  };
  const unmeasuredGoal = mkGoal('Ship the thing');           // no metric at all
  mkTask(unmeasuredGoal.id, 'done');
  const measuredGoal = mkGoal('Clicks to 100', { name: 'clicks', unit: '/day', target: 100, baseline: 50, direction: 'up', everyDays: 1 });
  feed(measuredGoal, [[6, 57], [4, 55], [2, 56], [0, 59]]);  // nowhere near target
  mkTask(measuredGoal.id, 'done');
  const reachedGoal = mkGoal('Latency under 200', { name: 'p95', unit: 'ms', target: 200, baseline: 400, direction: 'down', everyDays: 1 });
  feed(reachedGoal, [[6, 380], [4, 300], [2, 240], [0, 180]]);   // target reached (down is better)
  mkTask(reachedGoal.id, 'done');

  const ready = aos.goals.readyToClose(aos.tenant, NOW).map((g) => g.id);
  assert(ready.includes(unmeasuredGoal.id), 'a goal with NO metric still closes on its tasks — unchanged', ready);
  assert(!ready.includes(measuredGoal.id), 'a measured goal whose number is nowhere near target is NOT offered', { ready, verdict: aos.goals.metricStatus(measuredGoal.id, NOW).verdict });
  assert(ready.includes(reachedGoal.id), 'a measured goal that reached its target IS offered', ready);
  // And the sweep that cards the owner reads the same list, so the card stops too.
  const before = aos.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(`system:goal-ready-${measuredGoal.id}`);
  assert(!before || before.n === 0, 'no "goal is finished" card for the measured goal', before);


  registry.stopAll();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})();
