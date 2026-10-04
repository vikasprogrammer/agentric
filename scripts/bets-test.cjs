#!/usr/bin/env node
/* Bets + assets — judging one ATTEMPT at a goal, on its own numbers.
 *
 * Two failures this pins, both from the instapods growth trial:
 *   - **Attribution.** Three bets ran inside four days while the goal's own number drifted DOWN for
 *     unrelated reasons. Judged on the goal, all three read as failures; judged on their own assets,
 *     they are separable. So lift is `sum(asset.value) − baseline`, never goal movement.
 *   - **Self-grading.** Insights drove ~zero action because the outcome was the agent's own opinion of
 *     its work. So `observedLift`/`verdict` are computed by the server and are absent from every write
 *     path an agent has; the agent owns the LESSON and the kept/killed call, and a disagreement with the
 *     arithmetic is recorded rather than prevented.
 *
 * Also pinned: a bet is not a task (no spawn, its own state machine), `no_signal` outranks failure when
 * nothing was indexed or measured, the live-bet cap, the window bounds, idempotent assets, and that a
 * re-lengthened window cannot postpone judgement forever.
 *
 * Isolated home; no ttyd.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bets-test-'));
process.env.AGENT_OS_HOME = HOME;
process.env.AGENT_OS_TENANT = 'testco';
process.env.AOS_NO_TTYD = '1';

let pass = 0, fail = 0;
const assert = (c, name, d) => c ? (pass++, console.log(`  \x1b[32m✓\x1b[0m ${name}`)) : (fail++, console.log(`  \x1b[31m✗ ${name}\x1b[0m${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`));

const DAY = 86_400_000;

(async () => {
  const { TenantRegistry } = require(path.join(ROOT, 'dist/tenant-registry.js'));
  const { createHttpServer } = require(path.join(ROOT, 'dist/server.js'));
  const { reviewBets } = require(path.join(ROOT, 'dist/edge/bet-review.js'));
  const { MAX_LIVE_BETS, MET_FRACTION } = require(path.join(ROOT, 'dist/state/bets.js'));
  const registry = new TenantRegistry(ROOT, 0, path.join(ROOT, 'config/agent-os.config.json'));
  registry.bootAll();
  const { os: aos, tm } = registry.default();
  const server = createHttpServer(registry);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = aos.team.listMembers().find((m) => m.role === 'owner');
  const agent = [...aos.agents.values()][0].id;

  let seq = 0;
  const mkSession = () => {
    const id = `ses_bet${String(++seq).padStart(4, '0')}`;
    aos.db.prepare('INSERT INTO term_sessions (id, agent, title, task, tmux, status, spawned_by, created_at, secret, updated_at, run_as, claude_session_id, headless) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)')
      .run(id, agent, 'run', 'run', `aos-${id}`, 'running', 'automation:au_x', Date.now(), `sec-${id}`, Date.now(), owner.id, `claude-${id}`);
    return id;
  };
  const S = mkSession();
  const call = async (route, body) => (await fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aos-secret': `sec-${S}` },
    body: JSON.stringify({ session: S, ...body }),
  })).json();
  const propose = (body) => call('/api/agent/bets/propose', body);
  const update = (body) => call('/api/agent/bets/update', body);
  const record = (body) => call('/api/agent/bets/asset', body);
  const measure = (body) => call('/api/agent/bets/measure', body);

  const goal = aos.goals.create({
    tenant: aos.tenant, title: 'Organic clicks', owner: owner.id, createdBy: owner.id,
    metric: { name: 'clicks per day', unit: 'clicks/day', baseline: 50, target: 100, direction: 'up', everyDays: 1 },
  });
  const cards = (betId) => aos.db.prepare('SELECT title, body, status FROM messages WHERE session_id = ? ORDER BY id').all(`system:bet-${betId}`);

  console.log('\n\x1b[1m1) A bet is opened with a prediction and a window\x1b[0m');
  const a = await propose({ goalId: goal.id, title: 'Peer comparison pages', hypothesis: 'Peer "X vs Y" pages earn clicks at the rate the existing ones do', lever: 'comparison pages', expectedLift: 2, baseline: 0, windowDays: 21 });
  assert(a.ok && a.bet.state === 'running', 'it starts running', a);
  assert(Math.abs(a.bet.judgeAt - (Date.now() + 21 * DAY)) < 5000, 'the judge date is the window out', a.bet.judgeAt);
  assert(a.bet.createdBy === `agent:${agent}`, 'the agent that opened it is recorded', a.bet.createdBy);
  const held = await propose({ goalId: goal.id, title: 'Hold for a human', expectedLift: 1, start: false });
  assert(held.bet.state === 'proposed' && !held.bet.startedAt, 'start:false waits for a human and starts no clock', held.bet);

  console.log('\n\x1b[1m2) A bet is NOT a task\x1b[0m');
  const cols = aos.db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  assert(cols.includes('bet_id'), 'a task POINTS at a bet', cols.filter((c) => c.includes('bet')));
  const taskRows = aos.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE id = ?").get(a.bet.id);
  assert(taskRows.n === 0, 'opening a bet creates no task — so the dispatcher cannot spawn a session for it', taskRows);

  console.log('\n\x1b[1m3) Assets are the attribution join\x1b[0m');
  const r1 = await record({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/b/', kind: 'page' });
  assert(r1.ok && r1.asset.state === 'live', 'an asset is recorded', r1);
  const again = await record({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/b/' });
  assert(again.asset.id === r1.asset.id, 'recording the same url twice updates rather than duplicating', again.asset.id);
  await record({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/c/' });
  await record({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/d/' });
  const m1 = await measure({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/b/', value: 1.2, secondary: 300, position: 4.5, indexed: true });
  assert(m1.ok && m1.asset.value === 1.2 && m1.asset.indexed === true, 'measurements attach', m1.asset);
  const partial = await measure({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/c/', indexed: true });
  assert(partial.asset.value === undefined, 'a run that only checked indexing says only that — value is left unset', partial.asset);
  const missing = await measure({ betId: a.bet.id, url: 'https://x.test/nope/', value: 9 });
  assert(/record it first/.test(missing.error || ''), 'measuring an unrecorded url is refused', missing);

  console.log('\n\x1b[1m4) The verdict is computed from the assets, not from the goal\x1b[0m');
  // The GOAL goes the wrong way while the bet's own assets do well. The bet must still read `met`.
  [6, 4, 2, 0].forEach((d, i) => aos.goals.addReading(goal.id, 57 - i * 2, 'agent:measurer', { at: Date.now() - d * DAY }));
  await measure({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/c/', value: 0.9 });
  await measure({ betId: a.bet.id, url: 'https://x.test/apps/a/vs/d/', value: 0.4, indexed: true });
  const j = aos.bets.judge(a.bet.id, Date.now() + 22 * DAY);
  assert(Math.abs(j.observedLift - 2.5) < 0.001, 'lift is the assets total minus baseline', j);
  assert(j.verdict === 'met', `met at ${MET_FRACTION * 100}% of the prediction, even though the goal fell`, j);
  assert(aos.goals.metricStatus(goal.id).verdict === 'regressing', 'and the goal itself reads regressing — the two are separate judgements', aos.goals.metricStatus(goal.id).verdict);
  assert(j.bet.state === 'judging', 'judging, not auto-kept — retiring work is a human/agent call', j.bet.state);

  console.log('\n\x1b[1m5) An agent cannot grade its own bet\x1b[0m');
  const sneak = await update({ betId: a.bet.id, observedLift: 99, verdict: 'met', verdictNote: 'trust me' });
  const after = aos.bets.get(a.bet.id);
  assert(sneak.ok && Math.abs(after.observedLift - 2.5) < 0.001, 'observedLift is untouched by an agent write', after.observedLift);
  assert(after.verdictNote === j.note, 'and so is the verdict note', after.verdictNote);
  const noLesson = await update({ betId: a.bet.id, state: 'kept', lesson: '' });
  assert(/lesson/.test(noLesson.error || ''), 'keeping/killing without a lesson is refused', noLesson);
  const kept = await update({ betId: a.bet.id, state: 'kept', lesson: 'Peer pages index in under a week and rank 3-5; SaaS-axis pages do not.' });
  assert(kept.ok && kept.bet.state === 'kept' && kept.bet.judgedAt, 'with a lesson it is kept', kept.bet);

  console.log('\n\x1b[1m6) Disagreeing with the arithmetic is allowed, and visible\x1b[0m');
  const b = await propose({ goalId: goal.id, title: 'Good number, bad idea', expectedLift: 1, baseline: 0, windowDays: 7 });
  await record({ betId: b.bet.id, url: 'https://x.test/spammy/' });
  await measure({ betId: b.bet.id, url: 'https://x.test/spammy/', value: 5, indexed: true });
  const jb = aos.bets.judge(b.bet.id, Date.now() + 8 * DAY);
  assert(jb.verdict === 'met', 'the arithmetic says met', jb.verdict);
  await update({ betId: b.bet.id, state: 'killed', lesson: 'It worked and we still will not do it — thin pages we would not defend.' });
  const row = aos.db.prepare("SELECT data FROM audit_events WHERE type = 'bet.updated' AND data LIKE ? ORDER BY ts DESC LIMIT 1").get(`%${b.bet.id}%`);
  const d6 = JSON.parse(row.data);
  assert(d6.to === 'killed' && d6.verdict === 'met', 'the audit row carries BOTH the decision and the arithmetic it went against', d6);

  console.log('\n\x1b[1m7) No signal is not failure\x1b[0m');
  const c = await propose({ goalId: goal.id, title: 'Never indexed', expectedLift: 3, baseline: 0, windowDays: 14 });
  await record({ betId: c.bet.id, url: 'https://x.test/thin-1/' });
  await record({ betId: c.bet.id, url: 'https://x.test/thin-2/' });
  await measure({ betId: c.bet.id, url: 'https://x.test/thin-1/', value: 0, indexed: false });
  await measure({ betId: c.bet.id, url: 'https://x.test/thin-2/', value: 0, indexed: false });
  const jc = aos.bets.judge(c.bet.id, Date.now() + 15 * DAY);
  assert(jc.verdict === 'no_signal', 'all-unindexed assets mean untested, not failed', jc);
  const d = await propose({ goalId: goal.id, title: 'Shipped nothing', expectedLift: 2, windowDays: 7 });
  const jd = aos.bets.judge(d.bet.id, Date.now() + 8 * DAY);
  assert(jd.verdict === 'no_signal' && /shipped nothing/i.test(jd.note), 'a bet with no assets is no_signal with a note that says so', jd.note);

  console.log('\n\x1b[1m8) A short bet reads short\x1b[0m');
  await update({ betId: c.bet.id, state: 'killed', lesson: 'Thin pages do not get indexed here.' });
  await update({ betId: d.bet.id, state: 'killed', lesson: 'Never started.' });
  const e = await propose({ goalId: goal.id, title: 'Half as good as hoped', expectedLift: 10, baseline: 2, windowDays: 7 });
  await record({ betId: e.bet.id, url: 'https://x.test/meh/' });
  await measure({ betId: e.bet.id, url: 'https://x.test/meh/', value: 4, indexed: true });
  const je = aos.bets.judge(e.bet.id, Date.now() + 8 * DAY);
  assert(je.verdict === 'short' && Math.abs(je.observedLift - 2) < 0.001, 'below half the prediction is short', je);

  console.log('\n\x1b[1m9) The sweep cards the goal owner, once\x1b[0m');
  const f = await propose({ goalId: goal.id, title: 'Swept bet', hypothesis: 'A sweep should judge this', expectedLift: 1, baseline: 0, windowDays: 7 });
  await record({ betId: f.bet.id, url: 'https://x.test/swept/' });
  await measure({ betId: f.bet.id, url: 'https://x.test/swept/', value: 0.7, indexed: true });
  const swept = reviewBets(aos, tm, Date.now() + 8 * DAY);
  const mine = swept.find((r) => r.betId === f.bet.id);
  assert(mine && mine.verdict === 'met' && mine.carded, 'the sweep judges and cards it', mine);
  const c9 = cards(f.bet.id).filter((x) => x.status === 'open');
  assert(c9.length === 1 && /Bet worked/.test(c9[0].title), 'the card leads with the verdict in words', c9.map((x) => x.title));
  assert(/Hypothesis/.test(c9[0].body) && /0\.7/.test(c9[0].body), 'and carries the hypothesis + the measured number', c9[0] && c9[0].body.slice(0, 200));
  const again9 = reviewBets(aos, tm, Date.now() + 9 * DAY);
  assert(!again9.some((r) => r.betId === f.bet.id), 'a second sweep does not re-judge it', again9);
  assert(cards(f.bet.id).length === 1, 'and raises no second card', cards(f.bet.id).length);

  console.log('\n\x1b[1m10) Caps and bounds\x1b[0m');
  while (aos.bets.liveCount(aos.tenant, goal.id) < MAX_LIVE_BETS) {
    const r = await propose({ goalId: goal.id, title: `Filler ${aos.bets.liveCount(aos.tenant, goal.id)}`, expectedLift: 1, windowDays: 7 });
    if (!r.ok) break;
  }
  const over = await propose({ goalId: goal.id, title: 'One too many', expectedLift: 1 });
  assert(/live bets/.test(over.error || ''), `the ${MAX_LIVE_BETS}-live-bet cap holds`, over);
  // Free one slot the way an operator would, then check the window bounds.
  const victim = aos.bets.list(aos.tenant, { goalId: goal.id, state: 'live' })[0];
  aos.bets.update(victim.id, { state: 'killed', lesson: 'Making room for the bounds check.', by: owner.id });
  const shortWin = aos.bets.create({ tenant: aos.tenant, goalId: goal.id, title: 'Clamp me', windowDays: 1, createdBy: owner.id });
  assert(shortWin.windowDays === 7, 'a 1-day window is clamped up to 7', shortWin.windowDays);
  const longWin = aos.bets.update(shortWin.id, { windowDays: 900, by: owner.id });
  assert(longWin.windowDays === 60, 'a 900-day window is clamped down to 60', longWin.windowDays);
  assert(Math.abs(longWin.judgeAt - (longWin.startedAt + 60 * DAY)) < 5000, 'and the judge date is re-stamped off the ORIGINAL start, not from now', { judgeAt: longWin.judgeAt, startedAt: longWin.startedAt });

  console.log('\n\x1b[1m11) A human can read the board\x1b[0m');
  const cookie = `aos_sid=${aos.team.createSession(owner.id)}`;
  const board = await (await fetch(`${base}/api/bets?goal=${goal.id}`, { headers: { cookie } })).json();
  assert(Array.isArray(board.bets) && board.bets.length > 0, 'GET /api/bets lists them', board.bets && board.bets.length);
  assert(board.bets.every((x) => Array.isArray(x.assets)), 'each with its assets');
  assert(board.counts && board.counts.kept === 1, 'and a count per state', board.counts);

  server.close();
  registry.stopAll?.();
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} process.exit(1); });
